import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) against TIDAL.
 *
 * This is a *second, separate* session from the one in `auth.ts`, and it exists because the
 * two do different jobs:
 *
 *   auth.ts       your developer-portal app, Authorization Code + PKCE, playlist scopes.
 *                 This is what `sync` uses and it is the supported path.
 *   this file     a Limited Input Device client, device flow, streaming scopes.
 *                 This is what `download` uses.
 *
 * They cannot be merged. As `auth.ts` already records, TIDAL rejects a developer-portal
 * client on the device endpoint with "Client is not a Limited Input Device client", and a
 * developer-portal token never gets a `FULL` track manifest — only a 30-second PREVIEW with
 * `previewReason: FULL_REQUIRES_SUBSCRIPTION`, regardless of whether the account behind it
 * is a paying subscriber. Only a client id belonging to an actual TIDAL player is granted
 * playback, which is why `TIDAL_DEVICE_CLIENT_ID` is a separate setting you supply.
 */
const DEVICE_AUTHORIZATION_URL = "https://auth.tidal.com/v1/oauth2/device_authorization";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

/** What a player asks for: read user, write user, write subscription-scoped resources. */
const DEVICE_SCOPES = "r_usr w_usr w_sub";

/** Refresh this far before the token actually expires, to absorb clock skew and slow calls. */
const REFRESH_SKEW_MS = 60_000;

export class DeviceAuthError extends Error {}

export class DeviceNotAuthenticatedError extends Error {
  constructor() {
    super(
      "No TIDAL playback session. Run:\n" +
        "  bun run src/index.ts download-login\n" +
        "This is separate from `login` — see src/tidal/device-auth.ts for why.",
    );
  }
}

type StoredSession = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId?: string;
  countryCode?: string;
};

type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

/**
 * Holds the playback session and keeps it fresh.
 *
 * Refreshing is serialised through `refreshInflight` because a batch download runs many
 * track fetches concurrently; without it, a token expiring mid-batch would fire one refresh
 * per in-flight request and TIDAL would invalidate all but one of the results.
 */
export class DeviceSession {
  private session?: StoredSession;
  private refreshInflight?: Promise<string>;

  private constructor(
    private readonly config: Config,
    private readonly path: string,
  ) {}

  static async open(config: Config): Promise<DeviceSession> {
    const session = new DeviceSession(config, join(config.dataDir, "tidal-download.session.json"));
    await session.load();
    return session;
  }

  get isAuthenticated(): boolean {
    return this.session !== undefined;
  }

  get countryCode(): string {
    return this.session?.countryCode ?? this.config.tidal.countryCode;
  }

  private clientId(): string {
    const clientId = this.config.tidal.deviceClientId;
    if (!clientId) {
      throw new DeviceAuthError(
        "TIDAL_DEVICE_CLIENT_ID is not set. Downloads need the client id of a TIDAL " +
          "player that supports the device flow; a developer-portal client is rejected " +
          "with \"Client is not a Limited Input Device client\".",
      );
    }
    return clientId;
  }

  /** Body shared by every token-endpoint call. Some player clients also require a secret. */
  private tokenCredentials(): Record<string, string> {
    const credentials: Record<string, string> = { client_id: this.clientId() };
    const secret = this.config.tidal.deviceClientSecret;
    if (secret) credentials.client_secret = secret;
    return credentials;
  }

  /** Step 1: ask TIDAL for a code the user types into link.tidal.com. */
  async requestDeviceCode(): Promise<DeviceAuthorization> {
    const response = await fetch(DEVICE_AUTHORIZATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...this.tokenCredentials(), scope: DEVICE_SCOPES }),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      throw new DeviceAuthError(
        `TIDAL refused the device authorization request (${response.status}): ` +
          `${body.error_description ?? body.error ?? "no detail"}`,
      );
    }

    const deviceCode = body.deviceCode ?? body.device_code;
    const userCode = body.userCode ?? body.user_code;
    if (typeof deviceCode !== "string" || typeof userCode !== "string") {
      throw new DeviceAuthError(`Unexpected device authorization response: ${JSON.stringify(body).slice(0, 300)}`);
    }

    return {
      deviceCode,
      userCode,
      verificationUri: String(body.verificationUri ?? body.verification_uri ?? "link.tidal.com"),
      verificationUriComplete: (body.verificationUriComplete ?? body.verification_uri_complete) as string | undefined,
      expiresIn: Number(body.expiresIn ?? body.expires_in ?? 300),
      interval: Number(body.interval ?? 2),
    };
  }

  /**
   * Step 2: poll until the user finishes in their browser.
   *
   * `authorization_pending` is the normal answer and must not be treated as an error;
   * `slow_down` means back off permanently, not just once, per RFC 8628 §3.5.
   */
  async pollForToken(authorization: DeviceAuthorization): Promise<void> {
    const deadline = Date.now() + authorization.expiresIn * 1000;
    let intervalMs = Math.max(authorization.interval, 1) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...this.tokenCredentials(),
          device_code: authorization.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          scope: DEVICE_SCOPES,
        }),
      });

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        await this.store(body);
        log.info("TIDAL playback session authorised", { userId: this.session?.userId ?? "unknown" });
        return;
      }

      const error = String(body.error ?? "");
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (error === "expired_token") break;

      const detail = body.error_description ?? (error || response.status);
      throw new DeviceAuthError(`Device authorisation failed: ${detail}`);
    }

    throw new DeviceAuthError("Device code expired before it was approved. Run the command again.");
  }

  /** A valid access token, refreshing first if the stored one is spent. */
  async accessToken(): Promise<string> {
    if (!this.session) throw new DeviceNotAuthenticatedError();
    if (Date.now() < this.session.expiresAt - REFRESH_SKEW_MS) return this.session.accessToken;

    this.refreshInflight ??= this.refresh().finally(() => {
      this.refreshInflight = undefined;
    });
    return await this.refreshInflight;
  }

  private async refresh(): Promise<string> {
    if (!this.session) throw new DeviceNotAuthenticatedError();

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...this.tokenCredentials(),
        refresh_token: this.session.refreshToken,
        grant_type: "refresh_token",
        scope: DEVICE_SCOPES,
      }),
    });

    if (!response.ok) {
      // A rejected refresh token is terminal: drop it so the next run says "log in again"
      // rather than looping on a credential that will never work.
      await this.clear();
      throw new DeviceNotAuthenticatedError();
    }

    const body = (await response.json()) as Record<string, unknown>;
    await this.store(body);
    log.debug("Refreshed TIDAL playback token");
    return this.session.accessToken;
  }

  /** TIDAL omits `refresh_token` on a refresh response; keep the existing one in that case. */
  private async store(body: Record<string, unknown>): Promise<void> {
    const accessToken = body.access_token;
    if (typeof accessToken !== "string") {
      throw new DeviceAuthError(`Token response carried no access_token: ${JSON.stringify(body).slice(0, 200)}`);
    }

    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : this.session?.refreshToken;
    if (!refreshToken) throw new DeviceAuthError("Token response carried no refresh_token and none was stored.");

    const user = body.user as { userId?: number | string; countryCode?: string } | undefined;

    this.session = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + Number(body.expires_in ?? 86400) * 1000,
      userId: user?.userId !== undefined ? String(user.userId) : this.session?.userId,
      countryCode: user?.countryCode ?? ((body.countryCode as string | undefined) || this.session?.countryCode),
    };

    await this.save();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoredSession;
      if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string") {
        this.session = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read stored playback session", { error: String(error) });
      }
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    // 0600: this blob is refresh-token equivalent, same as the SDK's credential file.
    await writeFile(temporary, JSON.stringify(this.session, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async clear(): Promise<void> {
    this.session = undefined;
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
