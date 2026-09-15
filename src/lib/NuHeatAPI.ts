const fetchModule = require("node-fetch-cjs") as {
  default: (url: string, options?: FetchOptions) => Promise<ResponseLike>;
  FetchError: new (...args: any[]) => Error & { code?: string };
  Headers: new () => HeadersLike;
  isRedirect: (status: number) => boolean;
};
const htmlParser = require("node-html-parser") as {
  parse: (html: string) => any;
};

const fetch = fetchModule.default;
const FetchError = fetchModule.FetchError;
const HeadersCtor = fetchModule.Headers;
const isRedirect = fetchModule.isRedirect;
const { parse } = htmlParser;

import { createHash, randomBytes } from "node:crypto";
import {
  NUHEAT_API_AUTHORIZE_URI,
  NUHEAT_API_CLIENT_ID,
  NUHEAT_API_CLIENT_SECRET,
  NUHEAT_API_CONSENT_URI,
  NUHEAT_API_REDIRECT_URI,
  NUHEAT_API_TOKEN_URI,
  buildNuHeatApiUrl,
} from "./settings";
import {
  SCHEDULE_MODE,
  normalizeAccount,
  normalizeEnergyUsage,
  normalizeGroup,
  normalizeSchedule,
  normalizeThermostat,
} from "./NuHeatModels";
import type { LoggerLike } from "./types";

interface HeadersLike {
  set(name: string, value: string): void;
  raw?(): Record<string, string[]>;
  get?(name: string): string | null;
}

interface ResponseLike {
  status: number;
  ok: boolean;
  statusText: string;
  headers: {
    raw?(): Record<string, string[]>;
    get(name: string): string | null;
  };
  url: string;
  json(): Promise<any>;
  text(): Promise<string>;
}

interface FetchOptions {
  method?: string;
  headers?: HeadersLike | Record<string, string>;
  body?: string;
  redirect?: string;
  [key: string]: unknown;
}

interface ApiAuthOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface ApiCallOptions<T = any> {
  normalize?: (value: any) => T;
  normalizeArray?: boolean;
  treatNoContentAsSuccess?: boolean;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
  token_type: string;
}

const OAUTH_SCOPES = ["openapi", "openid", "profile", "offline_access"] as const;

class NuHeatAPI {
  email: string;
  password: string;
  log: LoggerLike;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRedirectUri: string;
  usingBuiltInClient: boolean;
  usePkce: boolean;
  pkceCodeVerifier: string;
  headers: HeadersLike;
  accessToken: string | null;
  accessTokenTimestamp: number;
  refreshInterval: number;
  refreshToken: string;
  tokenScope: string;
  tokenType: string;

  constructor(
    email: string,
    password: string,
    log: LoggerLike,
    options: ApiAuthOptions = {},
  ) {
    this.email = email;
    this.password = password;
    this.log = log;
    const configuredClientId =
      options.clientId || process.env.NUHEAT_API_CLIENT_ID || "";
    const configuredClientSecret =
      options.clientSecret || process.env.NUHEAT_API_CLIENT_SECRET || "";
    const usingBuiltInPublicClient =
      !configuredClientId || configuredClientId === NUHEAT_API_CLIENT_ID;
    this.oauthClientId = configuredClientId || NUHEAT_API_CLIENT_ID;
    this.oauthClientSecret = usingBuiltInPublicClient
      ? ""
      : configuredClientSecret || NUHEAT_API_CLIENT_SECRET;
    this.oauthRedirectUri =
      options.redirectUri ||
      process.env.NUHEAT_API_REDIRECT_URI ||
      NUHEAT_API_REDIRECT_URI;
    this.usingBuiltInClient = usingBuiltInPublicClient;
    this.usePkce = !this.oauthClientSecret;
    this.pkceCodeVerifier = "";
    this.headers = new HeadersCtor();
    this.headers.set("Content-Type", "application/json");
    this.headers.set("Accept", "application/json");
    this.accessToken = null;
    this.accessTokenTimestamp = 0;
    this.refreshInterval = 0;
    this.refreshToken = "";
    this.tokenScope = "";
    this.tokenType = "Bearer";

    if (this.usingBuiltInClient) {
      this.log.info(
        "NuHeatAPI: Using built-in Nuheat PKCE public client ID " +
          this.oauthClientId +
          ".",
      );
    } else {
      this.log.info(
        "NuHeatAPI: Using configured OAuth client ID " + this.oauthClientId + ".",
      );
    }

    this.log.debug(
      "NuHeatAPI: OAuth redirect URI " +
        this.oauthRedirectUri +
        ". Requested scopes: " +
        this.getRequestedScope() +
        ". OAuth flow: " +
        (this.usePkce ? "authorization_code_pkce" : "authorization_code_secret"),
    );
  }

  getRequestedScope(): string {
    return OAUTH_SCOPES.join(" ");
  }

  generatePkceCodeVerifier(): string {
    return randomBytes(64).toString("base64url");
  }

  getPkceCodeChallenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier).digest("base64url");
  }

  buildAuthorizationCodeTokenRequest(redirectUrl: URL): URLSearchParams {
    const requestBody = new URLSearchParams({
      client_id: this.oauthClientId,
      code: redirectUrl.searchParams.get("code") || "",
      grant_type: "authorization_code",
      redirect_uri: this.oauthRedirectUri,
      scope: redirectUrl.searchParams.get("scope") || "",
    });

    if (this.usePkce) {
      requestBody.set("code_verifier", this.pkceCodeVerifier);
    } else {
      requestBody.set("client_secret", this.oauthClientSecret);
    }

    return requestBody;
  }

  buildRefreshTokenRequest(): URLSearchParams {
    const requestBody = new URLSearchParams({
      client_id: this.oauthClientId,
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      scope: this.tokenScope,
    });

    if (!this.usePkce) {
      requestBody.set("client_secret", this.oauthClientSecret);
      requestBody.set("redirect_uri", this.oauthRedirectUri);
    }

    return requestBody;
  }

  async setAwayMode(groupId: string | number, awayMode: boolean): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Group");
    const callOptions: FetchOptions = {
      body: JSON.stringify({
        groupId,
        awayMode,
      }),
      method: "PUT",
    };

    return await this.makeAPICall(callURL, callOptions);
  }

  async setHeatSetpoint(
    serialNumber: string,
    setPointTemp: number | string,
    holdLength: number,
  ): Promise<any> {
    let scheduleMode: number;
    let holdSetPointDateTime: string | undefined;
    if (holdLength >= 1440) {
      scheduleMode = SCHEDULE_MODE.PERMANENT_HOLD;
    } else if (holdLength > 0) {
      scheduleMode = SCHEDULE_MODE.HOLD;
      holdSetPointDateTime =
        new Date(Date.now() + holdLength * 60 * 1000)
          .toISOString()
          .split(".")[0]
          .toString() + "Z";
    } else {
      scheduleMode = SCHEDULE_MODE.AUTO;
    }

    const callURL = buildNuHeatApiUrl("/api/v1/Thermostat");
    const callBody: Record<string, number | string> = {
      serialNumber,
      setPointTemp,
      scheduleMode,
    };
    if (holdSetPointDateTime) {
      callBody.holdSetPointDateTime = holdSetPointDateTime;
    }
    this.log.debug(
      "NuHeatAPI: Setting thermostat " +
        serialNumber +
        " to " +
        setPointTemp +
        " with schedule mode " +
        scheduleMode +
        ".",
    );
    const callOptions: FetchOptions = {
      body: JSON.stringify(callBody),
      method: "PUT",
    };

    return await this.makeAPICall(callURL, callOptions);
  }

  async resumeSchedule(serialNumber: string): Promise<any> {
    return this.updateThermostat({
      serialNumber,
      scheduleMode: SCHEDULE_MODE.AUTO,
    });
  }

  async updateThermostat(thermostatUpdate: Record<string, unknown>): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Thermostat");
    const callOptions: FetchOptions = {
      body: JSON.stringify(thermostatUpdate),
      method: "PUT",
    };

    return await this.makeAPICall(callURL, callOptions, {
      normalize: normalizeThermostat,
    });
  }

  async refreshGroup(groupId: string | number): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Group/" + groupId);
    return await this.makeAPICall(callURL, {}, { normalize: normalizeGroup });
  }

  async refreshGroups(): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Group");
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeGroup,
      normalizeArray: true,
    });
  }

  async refreshThermostat(serialNumber: string): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Thermostat/" + serialNumber);
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeThermostat,
    });
  }

  async refreshThermostats(): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Thermostat");
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeThermostat,
      normalizeArray: true,
    });
  }

  async getAccount(): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Account");
    return await this.makeAPICall(callURL, {}, { normalize: normalizeAccount });
  }

  async refreshSchedule(serialNumber: string): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Schedule/" + serialNumber);
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeSchedule,
    });
  }

  async refreshSchedules(): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Schedule");
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeSchedule,
      normalizeArray: true,
    });
  }

  async updateSchedule(scheduleModel: Record<string, unknown>): Promise<any> {
    const callURL = buildNuHeatApiUrl("/api/v1/Schedule");
    return await this.makeAPICall(
      callURL,
      {
        body: JSON.stringify(scheduleModel),
        method: "PUT",
      },
      {
        treatNoContentAsSuccess: true,
      },
    );
  }

  async refreshEnergyLogDay(serialNumber: string, date: string): Promise<any> {
    const callURL =
      buildNuHeatApiUrl("/api/v1/EnergyLog/Day/" + serialNumber + "/" + date);
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeEnergyUsage,
    });
  }

  async refreshEnergyLogWeek(serialNumber: string, date: string): Promise<any> {
    const callURL =
      buildNuHeatApiUrl("/api/v1/EnergyLog/Week/" + serialNumber + "/" + date);
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeEnergyUsage,
    });
  }

  async refreshEnergyLogMonth(serialNumber: string, year: string): Promise<any> {
    const callURL =
      buildNuHeatApiUrl(
        "/api/v1/EnergyLog/Month/" + serialNumber + "/" + year,
      );
    return await this.makeAPICall(callURL, {}, {
      normalize: normalizeEnergyUsage,
    });
  }

  async makeAPICall<T = any>(
    callURL: string,
    callOptions: FetchOptions = {},
    options: ApiCallOptions<T> = {},
  ): Promise<T | T[] | boolean | false> {
    if (!(await this.refreshAccessToken())) {
      return false;
    }
    const response = await this.fetch(callURL, callOptions);
    if (!response) {
      this.log.debug(
        "NuHeatAPI: Unable to make API call. Acquiring a new access token.",
      );
      this.accessToken = null;
      return false;
    }
    if (response.status === 204) {
      return true;
    }
    const returnedData = await response.json();

    if (options.normalize) {
      if (options.normalizeArray && Array.isArray(returnedData)) {
        return returnedData.map(options.normalize);
      }

      return options.normalize(returnedData);
    }

    return returnedData;
  }

  describeRequest(url: string, options: FetchOptions = {}): string {
    return (options.method || "GET") + " " + url;
  }

  async readResponseBody(response: ResponseLike): Promise<string> {
    try {
      const responseText = await response.text();
      if (!responseText) {
        return "";
      }

      return responseText.replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
      return "";
    }
  }

  findForm(html: any, selector: string): any {
    return (
      html
        .querySelectorAll("form")
        .find((form: any) => form.querySelector(selector)) || html
    );
  }

  getFormAction(form: any, baseUrl: string, fallbackUrl: string): string {
    return new URL(
      form.getAttribute?.("action") || fallbackUrl,
      baseUrl,
    ).toString();
  }

  getInputValue(html: any, name: string): string {
    return (
      html.querySelector("input[name=" + name + "]")?.getAttribute("value") ||
      ""
    );
  }

  getCheckedInputValues(html: any, name: string): string[] {
    const values: string[] = [];

    for (const input of html.querySelectorAll("input[name=" + name + "]")) {
      const type = (input.getAttribute("type") || "").toLowerCase();
      const value = input.getAttribute("value") || "";
      if (
        value &&
        ((type === "checkbox" && input.hasAttribute("checked")) ||
          type === "hidden")
      ) {
        if (!values.includes(value)) {
          values.push(value);
        }
      }
    }

    return values;
  }

  getHtmlMetaRefreshUrl(htmlText: string, baseUrl: string): string {
    const html = parse(htmlText);
    const metaRefresh = html
      .querySelectorAll("meta")
      .find(
        (node: any) =>
          (node.getAttribute("http-equiv") || "").toLowerCase() === "refresh",
      );
    const refreshContent = metaRefresh?.getAttribute("content") || "";
    const redirectMatch = refreshContent.match(/url\s*=\s*([^;]+)/i);

    if (!redirectMatch) {
      return "";
    }

    const redirectUrl = redirectMatch[1]
      .trim()
      .replace(/^['"]|['"]$/g, "");
    return new URL(redirectUrl, baseUrl).toString();
  }

  mergeCookies(...cookies: Array<string | false | null | undefined>): string {
    const cookiePairs = new Map<string, string>();

    for (const cookie of cookies) {
      if (!cookie) {
        continue;
      }

      for (const cookiePair of cookie.split(/;\s*/)) {
        const cookieName = cookiePair.split("=")[0];
        if (cookieName) {
          cookiePairs.set(cookieName, cookiePair);
        }
      }
    }

    return Array.from(cookiePairs.values()).join("; ");
  }

  async followHtmlMetaRefresh(
    response: ResponseLike,
    cookie: string,
  ): Promise<ResponseLike | null> {
    if (response.headers.get("location")) {
      return response;
    }

    const redirectUrl = this.getHtmlMetaRefreshUrl(
      await response.text(),
      response.url,
    );

    if (!redirectUrl) {
      return response;
    }

    this.log.debug(
      "NuHeatAPI: Following OAuth browser redirect to " +
        new URL(redirectUrl).pathname +
        ".",
    );

    const redirectResponse = await this.fetch(redirectUrl, {
      headers: {
        Cookie: cookie,
      },
      redirect: "manual",
    });

    if (!redirectResponse) {
      this.log.error("NuHeatAPI: Unable to follow the OAuth browser redirect.");
      return null;
    }

    return redirectResponse;
  }

  getRedirectUrl(response: ResponseLike): URL | null {
    const location = response.headers.get("location");

    if (!location) {
      return null;
    }

    return new URL(location, NUHEAT_API_AUTHORIZE_URI);
  }

  isFinalAuthorizationRedirect(response: ResponseLike): boolean {
    const redirectUrl = this.getRedirectUrl(response);

    if (!redirectUrl) {
      return false;
    }

    return (
      redirectUrl.searchParams.has("code") ||
      redirectUrl.searchParams.has("error")
    );
  }

  needsOAuthConsent(response: ResponseLike): boolean {
    const redirectUrl = this.getRedirectUrl(response);

    if (!redirectUrl || this.isFinalAuthorizationRedirect(response)) {
      return false;
    }

    const redirectPath = redirectUrl.pathname.toLowerCase();
    return (
      redirectPath === "/connect/authorize/callback" ||
      redirectPath === "/consent"
    );
  }

  async oauthGetAuthPage(): Promise<ResponseLike | null> {
    const authEndpoint = new URL(NUHEAT_API_AUTHORIZE_URI);
    authEndpoint.searchParams.set("response_type", "code");
    authEndpoint.searchParams.set("client_id", this.oauthClientId);
    authEndpoint.searchParams.set("redirect_uri", this.oauthRedirectUri);
    authEndpoint.searchParams.set("scope", this.getRequestedScope());
    if (this.usePkce) {
      this.pkceCodeVerifier = this.generatePkceCodeVerifier();
      authEndpoint.searchParams.set(
        "code_challenge",
        this.getPkceCodeChallenge(this.pkceCodeVerifier),
      );
      authEndpoint.searchParams.set("code_challenge_method", "S256");
    }

    this.log.debug(
      "NuHeatAPI: Requesting OAuth authorization page with scopes: " +
        this.getRequestedScope() +
        (this.usePkce ? " using PKCE." : "."),
    );

    const response = await this.fetch(authEndpoint.toString(), {
      redirect: "follow",
    });
    if (!response) {
      this.log.error(
        "NuHeatAPI: Unable to access the OAuth authorization endpoint.",
      );
      return null;
    }

    return response;
  }

  async oauthLogin(authPage: ResponseLike): Promise<ResponseLike | null> {
    const cookie = this.trimSetCookie(authPage.headers.raw?.()["set-cookie"]);

    if (cookie) {
      const htmlText = await authPage.text();
      const loginPageHtml = parse(htmlText);
      const loginForm = this.findForm(loginPageHtml, "input[name=Password]");

      const requestVerificationToken = this.getInputValue(
        loginForm,
        "__RequestVerificationToken",
      );
      const requestReturnURL =
        this.getInputValue(loginForm, "ReturnUrl") ||
        this.getInputValue(loginPageHtml, "ReturnUrl");

      if (!requestVerificationToken) {
        this.log.error(
          "NuHeatAPI: Unable to complete OAuth login. The verification token could not be retrieved.",
        );
        return null;
      }

      const usernameField = loginForm.querySelector("input[name=Email]")
        ? "Email"
        : "Username";
      const loginBody = new URLSearchParams({
        ReturnUrl: requestReturnURL,
        [usernameField]: this.email,
        Password: this.password,
        button: "login",
        __RequestVerificationToken: requestVerificationToken,
      });
      const response = await this.fetch(authPage.url, {
        body: loginBody.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookie,
        },
        method: "POST",
        redirect: "manual",
      });

      if (!response) {
        this.log.error(
          "NuHeatAPI: Unable to complete OAuth login. Ensure your username and password are correct.",
        );
        return null;
      }

      if (
        response.headers &&
        response.headers.raw?.()["set-cookie"] &&
        response.headers.raw?.()["set-cookie"].length < 2
      ) {
        this.log.error(
          "NuHeatAPI: Invalid NuHeat credentials given. Check your login and password.",
        );
        return null;
      }
      return response;
    }

    return null;
  }

  async oauthConfirm(
    authPage: ResponseLike,
    sessionCookie: string,
  ): Promise<ResponseLike | null> {
    const redirectUrl = this.getRedirectUrl(authPage);

    if (!redirectUrl) {
      this.log.error("NuHeatAPI: Unable to complete the OAuth login redirect.");
      return null;
    }

    let confirmPage = await this.fetch(redirectUrl.toString(), {
      headers: {
        Cookie: sessionCookie,
      },
      redirect: "manual",
    });
    if (!confirmPage) {
      this.log.error("NuHeatAPI: Unable to complete the OAuth login redirect.");
      return null;
    }
    const callbackCookie = this.trimSetCookie(
      confirmPage.headers.raw?.()["set-cookie"],
    );
    const callbackSessionCookie = this.mergeCookies(sessionCookie, callbackCookie);

    if (this.isFinalAuthorizationRedirect(confirmPage)) {
      return confirmPage;
    }

    const confirmRedirectUrl = this.getRedirectUrl(confirmPage);
    if (confirmRedirectUrl?.pathname.toLowerCase() === "/consent") {
      confirmPage = await this.fetch(confirmRedirectUrl.toString(), {
        headers: {
          Cookie: callbackSessionCookie,
        },
        redirect: "manual",
      });

      if (!confirmPage) {
        this.log.error(
          "NuHeatAPI: Unable to access the OAuth consent confirmation page.",
        );
        return null;
      }
    }

    const cookie = this.trimSetCookie(confirmPage.headers.raw?.()["set-cookie"]);
    const consentSessionCookie = this.mergeCookies(callbackSessionCookie, cookie);

    if (consentSessionCookie) {
      const htmlText = await confirmPage.text();
      const loginPageHtml = parse(htmlText);
      const consentForm = this.findForm(
        loginPageHtml,
        "input[name=ScopesConsented]",
      );

      const requestVerificationToken = this.getInputValue(
        consentForm,
        "__RequestVerificationToken",
      );
      const requestReturnURL =
        this.getInputValue(consentForm, "ReturnUrl") ||
        this.getInputValue(loginPageHtml, "ReturnUrl");

      if (!requestVerificationToken) {
        this.log.error(
          "NuHeatAPI: Unable to complete OAuth login. The api access couldn't be confirmed.",
        );
        return null;
      }

      const loginBody = new URLSearchParams({
        ReturnUrl: requestReturnURL,
        button: "yes",
        RememberConsent: "true",
        __RequestVerificationToken: requestVerificationToken,
      });
      const checkedScopes = this.getCheckedInputValues(
        consentForm,
        "ScopesConsented",
      );
      const scopes = checkedScopes.length > 0 ? checkedScopes : [...OAUTH_SCOPES];
      for (const scope of scopes) {
        loginBody.append("ScopesConsented", scope);
      }

      this.log.debug(
        "NuHeatAPI: OAuth consent required. Confirming scopes: " +
          this.getRequestedScope(),
      );

      const consentUrl = this.getFormAction(
        consentForm,
        confirmPage.url,
        NUHEAT_API_CONSENT_URI,
      );

      const response = await this.fetch(consentUrl, {
        body: loginBody.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: consentSessionCookie,
        },
        method: "POST",
        redirect: "manual",
      });

      if (!response) {
        this.log.error(
          "NuHeatAPI: Unable to complete OAuth login. API access confirmation not completed.",
        );
        return null;
      }

      const responseCookie = this.trimSetCookie(
        response.headers.raw?.()["set-cookie"],
      );

      return await this.followHtmlMetaRefresh(
        response,
        this.mergeCookies(consentSessionCookie, responseCookie),
      );
    }

    return null;
  }

  async oauthRedirect(
    loginResponse: ResponseLike,
    sessionCookie: string,
  ): Promise<ResponseLike | null> {
    const redirectUrl = new URL(
      loginResponse.headers.get("location") || "",
      NUHEAT_API_AUTHORIZE_URI,
    );

    const cookie = this.mergeCookies(
      sessionCookie,
      this.trimSetCookie(loginResponse.headers.raw?.()["set-cookie"]),
    );

    if (cookie) {
      const response = await this.fetch(redirectUrl.toString(), {
        headers: {
          Cookie: cookie,
        },
        redirect: "manual",
      });
      if (!response) {
        this.log.error(
          "NuHeatAPI: Unable to complete the OAuth login redirect.",
        );
        return null;
      }
      return response;
    }

    return null;
  }

  async getAccessToken(): Promise<TokenResponse | null> {
    let response: ResponseLike | null = await this.oauthGetAuthPage();

    if (!response) {
      return null;
    }

    response = await this.oauthLogin(response);

    if (!response) {
      return null;
    }

    const sessionCookie = this.trimSetCookie(
      response.headers.raw?.()["set-cookie"],
    );

    if (sessionCookie) {
      response = await this.followHtmlMetaRefresh(response, sessionCookie);
      if (!response) {
        return null;
      }

      if (this.needsOAuthConsent(response)) {
        response = await this.oauthConfirm(response, sessionCookie);

        if (!response) {
          return null;
        }
      }

      if (!this.isFinalAuthorizationRedirect(response)) {
        response = await this.oauthRedirect(response, sessionCookie);
        if (!response) {
          return null;
        }
      }

      const redirectUrl = new URL(response.headers.get("location") || "");

      const requestBody = this.buildAuthorizationCodeTokenRequest(redirectUrl);

      response = await this.fetch(NUHEAT_API_TOKEN_URI, {
        body: requestBody.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });

      if (!response) {
        this.log.error("NuHeatAPI: Unable to acquire an OAuth access token.");
        return null;
      }
      this.tokenScope = redirectUrl.searchParams.get("scope") ?? "";
      const token = (await response.json()) as TokenResponse;
      this.log.debug(
        "NuHeatAPI: OAuth access token received. Granted scopes: " +
          (token.scope || this.tokenScope || "unknown") +
          ". Refresh token present: " +
          String(!!token.refresh_token),
      );

      return token;
    }

    return null;
  }

  async getRefreshedAccessToken(): Promise<boolean> {
    const requestBody = this.buildRefreshTokenRequest();

    const response = await this.fetch(NUHEAT_API_TOKEN_URI, {
      body: requestBody.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    if (!response) {
      return false;
    }

    const token = (await response.json()) as TokenResponse;
    const previousRefreshToken = this.refreshToken;
    this.accessToken = token.access_token;
    this.accessTokenTimestamp = Date.now();
    this.refreshInterval = token.expires_in;
    this.refreshToken = token.refresh_token;
    this.tokenScope = token.scope ?? this.tokenScope;
    this.tokenType = token.token_type;
    const refreshTokenRotated =
      !!previousRefreshToken && token.refresh_token !== previousRefreshToken;

    this.refreshInterval -= 420;

    if (this.refreshInterval < 300) {
      this.refreshInterval = 300;
    }

    this.headers.set(
      "Authorization",
      token.token_type + " " + token.access_token,
    );
    this.log.debug(
      "NuHeatAPI: Successfully refreshed the NuHeat API access token. Scope: " +
        this.tokenScope +
        ". Refresh token rotated: " +
        String(refreshTokenRotated) +
        ". Expires in: " +
        token.expires_in +
        " seconds.",
    );

    return true;
  }

  async returnAccessToken(): Promise<string | false> {
    if (this.accessToken) {
      if (
        Date.now() - this.accessTokenTimestamp > this.refreshInterval * 1000 &&
        Date.now() - this.accessTokenTimestamp < 1000 * 60 * 60 * 24 * 13.5
      ) {
        await this.getRefreshedAccessToken();
      }
    } else {
      await this.acquireAccessToken();
    }
    if (this.accessToken) {
      this.headers.set(
        "Authorization",
        this.tokenType + " " + this.accessToken,
      );
      return this.accessToken;
    } else {
      return false;
    }
  }

  async acquireAccessToken(): Promise<boolean> {
    let firstConnection = true;

    if (this.accessToken) {
      firstConnection = false;
      this.accessToken = null;
    }

    const token = await this.getAccessToken();

    if (!token) {
      return false;
    }

    if (firstConnection) {
      this.log.info("NuHeatAPI: Successfully connected to the NuHeat API.");
    } else {
      this.log.debug(
        "NuHeatAPI: Successfully reacquired a NuHeat API access token.",
      );
    }

    this.accessToken = token.access_token;
    this.accessTokenTimestamp = Date.now();
    this.tokenType = token.token_type;
    this.refreshInterval = token.expires_in;
    this.refreshToken = token.refresh_token;
    this.tokenScope = token.scope ?? this.tokenScope;

    this.headers.set("Authorization", this.tokenType + " " + this.accessToken);

    return true;
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.accessToken) {
      this.log.debug(
        "NuHeatAPI: Acquiring new access token. Ours seems to be missing",
      );
      return await this.acquireAccessToken();
    }

    if (Date.now() - this.accessTokenTimestamp < this.refreshInterval * 1000) {
      return true;
    }
    this.log.debug(
      "NuHeatAPI: Acquiring new access token. Ours has expired or is expiring soon",
    );

    if (await this.getRefreshedAccessToken()) {
      return true;
    }

    this.log.error(
      "NuHeatAPI: Unable to refresh our access token. " +
        "This error can usually be safely ignored and will be resolved by acquiring a new access token.",
    );

    if (!(await this.acquireAccessToken())) {
      this.log.error(
        "NuHeatAPI: Fatal error. We need a new access token didnt successfuly get one",
      );
      return false;
    }
    return true;
  }

  async fetch(
    url: string,
    options: FetchOptions = {},
    decodeResponse = true,
    isRetry = false,
  ): Promise<ResponseLike | null> {
    if (!options.headers) {
      options.headers = this.headers;
    }
    const requestDescription = this.describeRequest(url, options);
    try {
      const response = await fetch(url, options);
      if (!decodeResponse) {
        return response;
      }
      if (response.status === 400) {
        const responseBody = await this.readResponseBody(response);
        this.log.error(
          "NuHeatAPI: " +
            requestDescription +
            " failed with 400 Bad Request." +
            (responseBody ? " Response body: " + responseBody : ""),
        );
        return null;
      } else if (response.status === 401) {
        this.log.error(
          "NuHeatAPI: " +
            requestDescription +
            " failed with 401 Unauthorized. Check your NuHeat credentials.",
        );
        return null;
      } else if (response.status === 500) {
        const responseBody = await this.readResponseBody(response);
        this.log.error(
          "NuHeatAPI: " +
            requestDescription +
            " failed with 500 Internal Server Error." +
            (responseBody ? " Response body: " + responseBody : ""),
        );
        if (isRetry) {
          return null;
        } else {
          this.log.error("NuHeatAPI: Trying again.");
          return this.fetch(url, options, decodeResponse, true);
        }
      }
      if (!response.ok && !isRedirect(response.status)) {
        const responseBody = await this.readResponseBody(response);
        this.log.error(
          "NuHeatAPI: " +
            requestDescription +
            " failed with " +
            response.status +
            " " +
            response.statusText +
            "." +
            (responseBody ? " Response body: " + responseBody : ""),
        );
        return null;
      }
      return response;
    } catch (error) {
      if (error instanceof FetchError) {
        switch (error.code) {
          case "ECONNREFUSED":
            this.log.error("NuHeatAPI: Connection refused.");
            break;
          case "ECONNRESET":
            if (!isRetry) {
              this.log.debug(
                "NuHeatAPI: Connection reset during " +
                  requestDescription +
                  ". Retrying the API action.",
              );
              return this.fetch(url, options, decodeResponse, true);
            }
            this.log.error(
              "NuHeatAPI: Connection reset during " + requestDescription + ".",
            );
            break;
          case "ENOTFOUND":
            this.log.error("NuHeatAPI: Hostname or IP address not found.");
            break;
          case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
            this.log.error(
              "NuHeatAPI: Unable to verify the NuHeat TLS security certificate.",
            );
            break;
          default:
            this.log.error(
              "NuHeatAPI: " +
                requestDescription +
                " failed: " +
                error.message,
            );
        }
      } else {
        this.log.error(
          "NuHeatAPI: " + requestDescription + " failed with error: " + error,
        );
      }
      return null;
    }
  }

  trimSetCookie(setCookie?: string[]): string | false {
    if (setCookie) {
      return setCookie.map((x) => x.split(";")[0]).join("; ");
    } else {
      return false;
    }
  }
}

export = NuHeatAPI;
