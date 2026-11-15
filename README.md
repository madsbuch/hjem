# Hjem

**Your home, a little closer.**

Hjem means “home” in Danish. It is a Tauri 2 app for controlling a Home Assistant home from a phone, tablet, or desktop. A forest-green house mark, amber doorway, and warm ivory interface give everyday controls a calm, familiar place to live.

Start with the interactive demo home, then connect your own Home Assistant in Settings.

- Pin favourite devices for quick access.
- Browse rooms using your Home Assistant areas and device assignments.
- Search devices and filter by room or device type.
- Toggle lights, switches, fans, and input booleans; adjust supported light brightness.
- Set supported thermostat temperatures, operate covers, and play or pause media.
- Run existing Home Assistant scenes and view sensor readings.
- Receive live state changes, connection feedback, and automatic reconnection after an interrupted session.

Controls follow the capabilities each entity reports. Hidden and disabled registry entities are excluded. Devices without an area appear together as unassigned. Cameras, lock controls, and Home Assistant administration are outside the current scope.

## Run locally

Install Node.js and npm. Native builds also need Rust and the dependencies for your operating system listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run dev
```

Open [localhost:1435](http://localhost:1435) for the browser preview. To launch the native desktop app instead:

```sh
npm run tauri dev
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and build the frontend into `dist` |
| `npm test` | Run unit tests, including the Home Assistant protocol client |
| `npm run test:e2e` | Run browser interaction and responsive-layout tests |
| `npm run tauri -- build` | Build the desktop application and installers |

Install the browser needed by the end-to-end tests with `npx playwright install chromium` if it is not already available.

## Connect your home

1. In Home Assistant, open **User profile → Security → Long-lived access tokens** and create a token for Hjem. See [Home Assistant authentication](https://www.home-assistant.io/docs/authentication/).
2. In Hjem, open **Settings** and enter your Home Assistant URL, such as `http://homeassistant.local:8123` or your HTTPS remote address.
3. Paste the token and connect. Hjem discovers supported entities, areas, and existing scenes.

The token stays in memory for the current session; enter it again after restarting or reloading the app. Only the server URL and favourite preferences are stored locally. Disconnecting clears the client’s token. Hjem connects directly to your server using the [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/) and does not need an intermediary service.

Use HTTPS for remote access. An HTTP address uses an unencrypted WebSocket connection, so reserve it for a trusted local network. The server must be reachable from the device running Hjem. If you use a reverse proxy, it must forward WebSocket connections to `/api/websocket`. An HTTPS browser preview cannot connect to an HTTP server because browsers block mixed content.

## Phone and tablet

The interface adapts to narrow phone screens and wider tablets. Android project files are included under `src-tauri/gen/android`; platform builds still require the Android SDK, NDK, Java, and Rust targets described in the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets).

```sh
npm run android
npm run tauri -- android build
```

The first command runs on a connected device or emulator. The second creates a release build; distribution requires your own signing configuration.

Android release builds allow local HTTP access to `homeassistant.local` and the app’s local origins. For a different HTTP hostname or LAN IP, add that exact address to `src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml` and rebuild. HTTPS addresses do not need this exception. The debug configuration separately permits the local development server.

For iPhone and iPad, install full Xcode and `xcodegen`, configure Apple signing, and install the iOS Rust targets from the Tauri prerequisites. The iOS project has not yet been initialized. Then run:

```sh
npm run tauri -- ios init
npm run ios
```

The shared `src-tauri/Info.plist` includes a local-network permission explanation and support for local network connections. Allow local-network access when prompted. See the [Tauri development guide](https://v2.tauri.app/develop/) for device selection and platform tooling.

Real Home Assistant hardware and physical mobile devices have not yet been tested with this project. The included demo and automated tests exercise the interface and a simulated Home Assistant connection.

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | React and TypeScript interface |
| `src/lib/home-assistant.ts` | Authentication, state subscriptions, reconnection, and service calls |
| `src/lib/demo.ts` | Interactive sample home |
| `public/brand/` | Original SVG logo, wordmark, and app-icon master |
| `src-tauri/` | Rust application shell, platform configuration, and generated icons |

Hjem is an independent interface for Home Assistant, not an official Home Assistant application.
