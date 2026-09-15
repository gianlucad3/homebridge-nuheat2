import test from "node:test";
import assert from "node:assert/strict";

import NuHeatAPI = require("../lib/NuHeatAPI");
import {
  NUHEAT_API_AUTHORIZE_URI,
  NUHEAT_NOTIFICATION_HUB_URL,
  NUHEAT_IDENTITY_BASE_URL,
  buildNuHeatApiUrl,
} from "../lib/settings";
import { createLogStub } from "./support/helpers";

function withCleanNuheatEnv<T>(callback: () => T): T {
  const originalClientId = process.env.NUHEAT_API_CLIENT_ID;
  const originalClientSecret = process.env.NUHEAT_API_CLIENT_SECRET;
  const originalRedirectUri = process.env.NUHEAT_API_REDIRECT_URI;

  delete process.env.NUHEAT_API_CLIENT_ID;
  delete process.env.NUHEAT_API_CLIENT_SECRET;
  delete process.env.NUHEAT_API_REDIRECT_URI;

  try {
    return callback();
  } finally {
    restoreEnv("NUHEAT_API_CLIENT_ID", originalClientId);
    restoreEnv("NUHEAT_API_CLIENT_SECRET", originalClientSecret);
    restoreEnv("NUHEAT_API_REDIRECT_URI", originalRedirectUri);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function createResponse({
  status = 200,
  url = NUHEAT_API_AUTHORIZE_URI,
  location = null,
  setCookie = [],
  text = "",
}: {
  status?: number;
  url?: string;
  location?: string | null;
  setCookie?: string[];
  text?: string;
} = {}): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: {
      raw() {
        return {
          "set-cookie": setCookie,
        };
      },
      get(name: string) {
        return name.toLowerCase() === "location" ? location : null;
      },
    },
    url,
    async json() {
      return {};
    },
    async text() {
      return text;
    },
  };
}

test("default OAuth client uses Nuheat PKCE public client", () => {
  withCleanNuheatEnv(() => {
    const api = new NuHeatAPI("user@example.com", "password", createLogStub());

    assert.equal(api.oauthClientId, "homebridge-nuheat2_260421");
    assert.equal(api.oauthClientSecret, "");
    assert.equal(api.usePkce, true);
    assert.equal(api.usingBuiltInClient, true);
  });
});

test("default Nuheat endpoints use the Conductor NAM hosts", () => {
  assert.equal(
    NUHEAT_API_AUTHORIZE_URI,
    NUHEAT_IDENTITY_BASE_URL + "/connect/authorize",
  );
  assert.equal(
    buildNuHeatApiUrl("/api/v1/Thermostat"),
    (process.env.NUHEAT_API_BASE_URL || "https://api.nam.mynuheat.com")
      .replace(/\/+$/, "") + "/api/v1/Thermostat",
  );
  assert.equal(
    NUHEAT_NOTIFICATION_HUB_URL,
    (process.env.NUHEAT_API_BASE_URL || "https://api.nam.mynuheat.com")
      .replace(/\/+$/, "") + "/v2/notificationsHost",
  );
});

test("built-in public client ignores stale secrets without custom client ID", () => {
  withCleanNuheatEnv(() => {
    const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
      clientSecret: "stale-secret",
    });

    assert.equal(api.oauthClientId, "homebridge-nuheat2_260421");
    assert.equal(api.oauthClientSecret, "");
    assert.equal(api.usePkce, true);
  });
});

test("explicit built-in public client ID still uses PKCE and ignores stale secrets", () => {
  withCleanNuheatEnv(() => {
    const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
      clientId: "homebridge-nuheat2_260421",
      clientSecret: "stale-secret",
    });

    assert.equal(api.oauthClientId, "homebridge-nuheat2_260421");
    assert.equal(api.oauthClientSecret, "");
    assert.equal(api.usePkce, true);
    assert.equal(api.usingBuiltInClient, true);
  });
});

test("PKCE code challenge follows the S256 base64url transform", () => {
  const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
    clientId: "public-client",
  });
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  assert.equal(
    api.getPkceCodeChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("authorization request includes PKCE challenge for public clients", async () => {
  await withCleanNuheatEnv(async () => {
    const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
      clientId: "public-client",
    });
    api.generatePkceCodeVerifier = () => "test-code-verifier";

    let requestedUrl = "";
    api.fetch = async (url: string) => {
      requestedUrl = url;
      return {
        status: 200,
        ok: true,
        statusText: "OK",
        headers: {
          get() {
            return null;
          },
        },
        url,
        async json() {
          return {};
        },
        async text() {
          return "";
        },
      };
    };

    await api.oauthGetAuthPage();

    const authorizationUrl = new URL(requestedUrl);
    assert.equal(authorizationUrl.origin, NUHEAT_IDENTITY_BASE_URL);
    assert.equal(authorizationUrl.searchParams.get("client_id"), "public-client");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge"),
      api.getPkceCodeChallenge("test-code-verifier"),
    );
  });
});

test("authorization code token request uses verifier without client secret for PKCE", () => {
  const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
    clientId: "public-client",
  });
  api.pkceCodeVerifier = "test-code-verifier";

  const requestBody = api.buildAuthorizationCodeTokenRequest(
    new URL("http://localhost?code=abc123&scope=openapi%20offline_access"),
  );

  assert.equal(requestBody.get("client_id"), "public-client");
  assert.equal(requestBody.get("grant_type"), "authorization_code");
  assert.equal(requestBody.get("code"), "abc123");
  assert.equal(requestBody.get("code_verifier"), "test-code-verifier");
  assert.equal(requestBody.has("client_secret"), false);
});

test("legacy confidential clients include client secret and skip PKCE verifier", () => {
  const api = new NuHeatAPI("user@example.com", "password", createLogStub(), {
    clientId: "legacy-client",
    clientSecret: "legacy-secret",
  });
  api.refreshToken = "refresh-token";
  api.tokenScope = "openapi offline_access";

  const authorizationBody = api.buildAuthorizationCodeTokenRequest(
    new URL("http://localhost?code=abc123&scope=openapi%20offline_access"),
  );
  const refreshBody = api.buildRefreshTokenRequest();

  assert.equal(api.usePkce, false);
  assert.equal(authorizationBody.get("client_secret"), "legacy-secret");
  assert.equal(authorizationBody.has("code_verifier"), false);
  assert.equal(refreshBody.get("client_secret"), "legacy-secret");
  assert.equal(refreshBody.get("refresh_token"), "refresh-token");
});

test("OAuth login posts the Nuheat identity login form fields", async () => {
  const api = new NuHeatAPI("user@example.com", "password", createLogStub());
  const authPage = createResponse({
    url: "https://identity.nam.mynuheat.com/Account/Login?ReturnUrl=test",
    setCookie: ["anti-forgery=one; path=/"],
    text: `
      <form action="/Culture/SetCulture">
        <input name="__RequestVerificationToken" value="culture-token">
      </form>
      <form method="post">
        <input type="hidden" name="ReturnUrl" value="/connect/authorize/callback">
        <input type="text" name="Email">
        <input type="password" name="Password">
        <input type="hidden" name="__RequestVerificationToken" value="login-token">
      </form>
    `,
  });
  let requestedUrl = "";
  let requestBody = "";

  api.fetch = async (url: string, options: any) => {
    requestedUrl = url;
    requestBody = options.body;
    return createResponse({
      setCookie: ["session=one; path=/", "auth=two; path=/"],
    });
  };

  await api.oauthLogin(authPage);

  const postedForm = new URLSearchParams(requestBody);
  assert.equal(requestedUrl, authPage.url);
  assert.equal(postedForm.get("Email"), "user@example.com");
  assert.equal(postedForm.has("Username"), false);
  assert.equal(postedForm.get("__RequestVerificationToken"), "login-token");
  assert.equal(postedForm.get("ReturnUrl"), "/connect/authorize/callback");
});

test("setHeatSetpoint does not log the raw thermostat payload at info level", async () => {
  const messages: string[] = [];
  const log = {
    info(message: string) {
      messages.push(message);
    },
    debug() {},
    error() {},
    warn() {},
  };
  const api = new NuHeatAPI("user@example.com", "password", log as any);
  api.refreshAccessToken = async () => true;
  api.fetch = async () =>
    createResponse({
      status: 204,
      url: "https://api.nam.mynuheat.com/api/v1/Thermostat",
    });

  await api.setHeatSetpoint("123456789", 20, 1440);

  assert.equal(
    messages.some((message) => message.includes("serialNumber")),
    false,
  );
  assert.equal(
    messages.some((message) => message.includes("scheduleMode")),
    false,
  );
});

test("OAuth consent follows Nuheat HTML browser redirects with consent cookies", async () => {
  const api = new NuHeatAPI("user@example.com", "password", createLogStub());
  const authResponse = createResponse({
    location: "https://identity.nam.mynuheat.com/consent?returnUrl=test",
  });
  const calls: Array<{ url: string; options: any }> = [];

  api.fetch = async (url: string, options: any) => {
    calls.push({ url, options });

    if (calls.length === 1) {
      return createResponse({
        url,
        setCookie: ["consent=one; path=/"],
        text: `
          <form action="/Culture/SetCulture"></form>
          <form action="/Consent" method="post">
            <input type="hidden" name="ReturnUrl" value="/connect/authorize/callback">
            <input type="checkbox" name="ScopesConsented" value="openid" checked>
            <input type="checkbox" name="ScopesConsented" value="profile" checked>
            <input type="checkbox" name="ScopesConsented" value="openapi" checked>
            <input type="checkbox" name="ScopesConsented" value="offline_access" checked>
            <input type="hidden" name="__RequestVerificationToken" value="consent-token">
            <button name="button" value="yes">Yes, Allow</button>
          </form>
        `,
      });
    }

    if (calls.length === 2) {
      return createResponse({
        url,
        setCookie: ["grant=one; path=/"],
        text: `
          <meta http-equiv="refresh" content="0;url=/connect/authorize/callback?state=done">
        `,
      });
    }

    return createResponse({
      status: 302,
      url,
      location: "http://localhost?code=abc123&scope=openid%20profile%20openapi%20offline_access",
    });
  };

  const result = await api.oauthConfirm(authResponse, "session=one");

  assert.equal(
    result?.headers.get("location"),
    "http://localhost?code=abc123&scope=openid%20profile%20openapi%20offline_access",
  );
  assert.equal(calls[1].url, "https://identity.nam.mynuheat.com/Consent");

  const consentBody = new URLSearchParams(calls[1].options.body);
  assert.equal(consentBody.get("__RequestVerificationToken"), "consent-token");
  assert.deepEqual(consentBody.getAll("ScopesConsented"), [
    "openid",
    "profile",
    "openapi",
    "offline_access",
  ]);
  assert.match(calls[2].options.headers.Cookie, /session=one/);
  assert.match(calls[2].options.headers.Cookie, /consent=one/);
  assert.match(calls[2].options.headers.Cookie, /grant=one/);
});
