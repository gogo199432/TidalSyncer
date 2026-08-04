import { credentialsProvider, finalizeLogin, init, initializeLogin } from "@tidal-music/auth";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";
import { createFileStorage } from "./storage.ts";

/** Creating and rewriting playlists on the user's behalf needs both playlist scopes. */
const BASE_SCOPES = ["playlists.read", "playlists.write"];

/** Only requested by the features that read the collection; see `scopesFor`. */
const COLLECTION_SCOPE = "collection.read";

const CREDENTIALS_STORAGE_KEY = "listenbrainz-tidal-sync";

let initialized = false;

/**
 * The SDK invalidates stored credentials when the requested scopes are no longer a subset
 * of the granted ones, so asking for `collection.read` unconditionally would force every
 * user to log in again. Request it only when the feature that needs it is enabled.
 */
export function scopesFor(config: Config): string[] {
  const needsCollection = config.tidal.skipCollectionFor.length > 0 || config.syncFavorites;
  return needsCollection ? [...BASE_SCOPES, COLLECTION_SCOPE] : [...BASE_SCOPES];
}

/**
 * Prepares the auth module. Safe to call repeatedly; the SDK keeps module-level state
 * and re-initialising with different scopes would invalidate stored credentials.
 */
export async function initAuth(config: Config): Promise<void> {
  if (initialized) return;

  await init({
    clientId: config.tidal.clientId,
    clientSecret: config.tidal.clientSecret,
    credentialsStorageKey: CREDENTIALS_STORAGE_KEY,
    scopes: scopesFor(config),
    storage: createFileStorage(config.dataDir),
  });

  initialized = true;
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super(
      "No TIDAL user credentials stored. Run:\n" +
        "  docker compose run --rm --service-ports listenbrainz-tidal-sync login",
    );
  }
}

/** How long to wait for the user to finish logging in before giving up. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs the OAuth Authorization Code + PKCE flow.
 *
 * TIDAL's device flow is reserved for their own internally developed apps — a
 * developer-portal client is rejected with "Client is not a Limited Input Device client" —
 * so a browser round trip is the only option for a third-party app. It is needed exactly
 * once: afterwards the SDK refreshes the stored token on its own.
 *
 * By default we catch the redirect with a throwaway local HTTP server. `manual` instead
 * asks the user to paste the redirected URL back, for hosts where the browser cannot
 * reach the callback port.
 */
export async function browserLogin(config: Config, manual: boolean): Promise<void> {
  const { redirectUri } = config.tidal;
  const authorizeUrl = await initializeLogin({ redirectUri });

  console.log("");
  console.log("  Open this URL in a browser and log in to TIDAL:");
  console.log("");
  console.log(`    ${authorizeUrl}`);
  console.log("");

  if (manual) {
    await finalizeManually(redirectUri);
  } else {
    await finalizeViaCallbackServer(redirectUri);
  }

  log.info("TIDAL authorisation complete; credentials stored");
}

async function finalizeManually(redirectUri: string): Promise<void> {
  console.log(`  Your browser will land on ${redirectUri}?code=... — it may show a`);
  console.log("  connection error, which is fine. Copy the full address and paste it here.");
  console.log("");

  const pasted = prompt("  Redirected URL:");
  if (!pasted) throw new Error("No URL pasted; login aborted.");

  let query: string;
  try {
    query = new URL(pasted.trim()).search;
  } catch {
    throw new Error(`Could not parse "${pasted.trim()}" as a URL.`);
  }

  if (!query) throw new Error("That URL has no query string, so it carries no authorization code.");
  await finalizeLogin(query);
}

async function finalizeViaCallbackServer(redirectUri: string): Promise<void> {
  const target = new URL(redirectUri);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));

  const { promise, reject, resolve } = Promise.withResolvers<void>();

  // Settle only after the response has been flushed, otherwise stopping the server races
  // the reply and the browser sees a connection reset instead of the result page.
  const settle = (outcome: () => void) => setTimeout(outcome, 250);

  const server = Bun.serve({
    // 0.0.0.0 so the callback still arrives when this runs inside a container.
    hostname: "0.0.0.0",
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== target.pathname) return new Response("Not found", { status: 404 });

      const denial = url.searchParams.get("error");
      if (denial) {
        const detail = url.searchParams.get("error_description") ?? denial;
        settle(() => reject(new Error(`TIDAL refused the authorisation: ${detail}`)));
        return html("Authorisation failed", detail, 400);
      }

      // Browsers and health checks poke at this port; only a request carrying a code is
      // the real callback, so anything else must not abort the login.
      if (!url.searchParams.has("code")) {
        return html("Nothing to do", "This request carried no authorization code.", 400);
      }

      try {
        await finalizeLogin(url.search);
        settle(resolve);
        return html("Authorised", "You can close this tab and return to the terminal.");
      } catch (error) {
        settle(() => reject(error));
        return html("Authorisation failed", String(error), 400);
      }
    },
  });

  console.log(`  Waiting for the redirect on ${redirectUri} ...`);
  console.log("");

  const timeout = setTimeout(
    () => reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 60000} minutes waiting for login.`)),
    LOGIN_TIMEOUT_MS,
  );

  try {
    await promise;
  } finally {
    clearTimeout(timeout);
    await server.stop(true);
  }
}

function html(title: string, detail: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center">` +
      `<h1>${title}</h1><p>${detail}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Fails loudly if we do not hold a *user* token.
 *
 * Because a client secret is configured, `getCredentials` will happily fall back to a
 * client-credentials token, which authenticates the app but has no user attached — every
 * playlist write would then fail with a confusing permission error. Requiring `userId`
 * catches that case, as well as the not-logged-in-at-all case, where the SDK throws.
 */
export async function requireUserCredentials(): Promise<void> {
  let credentials: Awaited<ReturnType<typeof credentialsProvider.getCredentials>>;

  try {
    credentials = await credentialsProvider.getCredentials();
  } catch (error) {
    log.debug("getCredentials failed", { error: String(error) });
    throw new NotAuthenticatedError();
  }

  if (!credentials?.token || !credentials.userId) throw new NotAuthenticatedError();
}

export { credentialsProvider };
