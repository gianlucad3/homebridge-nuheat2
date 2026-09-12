# homebridge-nuheat2

[![npm version](https://img.shields.io/npm/v/homebridge-nuheat2.svg)](https://www.npmjs.com/package/homebridge-nuheat2)
[![npm downloads](https://img.shields.io/npm/dm/homebridge-nuheat2.svg)](https://www.npmjs.com/package/homebridge-nuheat2)

Homebridge platform plugin for Nuheat Signature floor-heating thermostats.

This maintained fork modernizes Nuheat support for current Homebridge releases while keeping the existing `NuHeat` platform configuration intact for backward compatibility. It builds on Shaun's original [`senorshaun/homebridge-nuheat`](https://github.com/senorshaun/homebridge-nuheat) plugin.

## Highlights

- Automatically discovers thermostats on the authenticated Nuheat account
- Optionally creates HomeKit switches for Nuheat group away mode
- Supports permanent, scheduled, and timed holds
- Uses Nuheat's OAuth-based API instead of legacy site scraping
- Uses the official Nuheat PKCE public client by default, with no distributable client secret
- Includes compatibility improvements for Homebridge 1.8+ and 2.0 betas
- Can optionally expose a schedule switch for each thermostat

## Compatibility

- Homebridge: `^1.8.0 || ^2.0.0-beta.0`
- Node.js: `^18.20.4 || ^20.18.0 || ^22 || ^24 || ^26`

For current Homebridge releases, use Node 22, 24, or 26.

## Installation

Install Homebridge first:

```bash
npm install -g homebridge
```

Then install the plugin:

```bash
npm install -g homebridge-nuheat2
```

The published package name for this maintained fork is `homebridge-nuheat2`. The Homebridge platform name in config remains `NuHeat`.

## Configuration

Most users should configure the plugin through the custom Homebridge admin UI. It is organized into Account, Accessories, Behavior, and Diagnostics panels.

Sensitive values are handled deliberately: saved passwords are not redisplayed in the UI. Leave the password field blank to keep the saved value, or enter a new value to replace it.

The Diagnostics panel summarizes the saved configuration and exposure strategy before restart. It does not make live Nuheat API calls.

The equivalent JSON looks like this:

```json
{
  "platform": "NuHeat",
  "name": "NuHeat",
  "email": "email@address.com",
  "password": "password123",
  "devices": [
    { "serialNumber": "1111111", "disabled": false },
    { "serialNumber": "2222222", "disabled": false }
  ],
  "autoPopulateAwayModeSwitches": true,
  "groups": [{ "groupName": "Main Floor", "disabled": false }],
  "exposeScheduleSwitches": false,
  "enableNotifications": true,
  "holdLength": 1440,
  "refresh": 60
}
```

### Options

- `platform`: Must be `NuHeat`
- `name`: Display name used in Homebridge logs
- `email`: MyNuheat account email address
- `Email`: Legacy alias still accepted for backward compatibility, but `email` is the preferred documented field
- `password`: MyNuheat account password
- `devices`: Optional list of thermostats to expose. If omitted or empty, every thermostat on the account will be discovered automatically. Blank rows in the UI are ignored
- `serialNumber`: Thermostat serial number from MyNuheat
- `disabled`: Available on `devices` and `groups` rows. Keeps the row saved while preventing that thermostat or group from being exposed
- `autoPopulateAwayModeSwitches`: Automatically expose away-mode switches for all groups on the account
- `exposeScheduleSwitches`: Optionally expose a switch per thermostat that reflects whether the thermostat is following its schedule and can be turned on to resume the schedule
- `groups`: Optional allow-list of groups to expose as away-mode switches. This only affects group/away-mode accessories. Blank rows in the UI are ignored
- `groupName`: Group name as shown in MyNuheat
- `holdLength`: Hold duration in minutes, default `1440`. Values are clamped from `0` to `1440`
- `refresh`: Poll interval in seconds, default `60`. Values lower than `30` are raised to `30` to reduce API traffic
- `enableNotifications`: Enables Nuheat SignalR notifications for faster updates. Defaults to `true`; set to `false` only while troubleshooting
- `debug`: Enables verbose Nuheat API, notification, and accessory logging. Defaults to `false`

### Hold Length Behavior

- `0`: hold until the next scheduled event
- `1-1439`: timed hold for the configured number of minutes
- `1440`: permanent hold

### Device Discovery

If `devices` is omitted or empty, the plugin will automatically expose every thermostat on the authenticated account.

If `groups` is omitted and `autoPopulateAwayModeSwitches` is enabled, the plugin will automatically expose away-mode switches for all groups on the account.

If `exposeScheduleSwitches` is enabled, the plugin will also create one switch per thermostat that turns on when the thermostat is following its Nuheat schedule and can be used to resume that schedule from HomeKit.

## Nuheat API Access

This plugin uses Nuheat's PKCE-based public client for normal authentication. The built-in public `clientId` is `homebridge-nuheat2_260421`; there is no distributable client secret and no user API key setup is required.

Nuheat migrated Signature thermostats to the Conductor server architecture in July 2026. Current plugin releases use the North America Conductor API hosts by default:

- Identity: `https://identity.nam.mynuheat.com`
- OpenAPI: `https://api.nam.mynuheat.com`
- Notifications: `https://api.nam.mynuheat.com/v2/notificationsHost`

References:

- [Nuheat OpenAPI docs](https://api.nam.mynuheat.com/)
- [Nuheat API access request page](https://www.nuheat.com/openapi)

## Troubleshooting

- Enable debug logging from the custom UI only while troubleshooting. Debug logs include detailed Nuheat API, notification, and accessory activity.
- If accessories do not appear after changing allow-lists, save the settings and restart the Nuheat child bridge.
- If login fails, confirm the same email and password work in the Nuheat app or web portal.
- If Nuheat changes regional API routing again, advanced users can temporarily override the runtime hosts with `NUHEAT_API_BASE_URL`, `NUHEAT_IDENTITY_BASE_URL`, and `NUHEAT_NOTIFICATION_HUB_URL`.
- If Homebridge shows stale UI fields after an update, close and reopen the plugin settings page.

## Development

The source of truth for the platform, API client, accessories, internal models, and tests lives under `src/`. The build compiles that back into the CommonJS layout used by Homebridge: `index.js`, `lib/`, and `test/`.

Common development commands:

```bash
npm run build
npm run typecheck
```

Run the test suite with:

```bash
npm test
```

Contributor and release notes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Attribution

This project is maintained by `applemanj` and retains attribution to SenorShaun for the original MIT-licensed Homebridge Nuheat plugin.

## Future Work

- Validate the PKCE public-client flow against more real-world Nuheat accounts.
- Verify group and away-mode behavior against current live API responses.
- Monitor Nuheat Conductor v2 notification behavior across more accounts and keep polling as the reliability fallback.
