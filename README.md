# Hjem

**A little more at home.**

Hjem means “home” in Danish. It is a Tauri 2 home screen for an Android tablet, with today’s calendar, Home Assistant scenes, and music on its home screen. Separate Controls and Apps pages keep devices and installed apps within reach. Its home-control interface also runs on phones and desktops. A navy-blue house mark, amber doorway, and cool blue interface give everyday controls a calm, familiar place to live.

Start with the interactive demo home, then connect your own Home Assistant in Settings.

- See today’s events from iCal/ICS subscription links and Home Assistant, including all-day and recurring events.
- Open Controls to browse rooms, adjust devices, and pin favourites.
- Open installed Android apps from a searchable app drawer and pin favourites in the app drawer.
- Browse rooms using your Home Assistant areas and device assignments.
- Search devices and filter by room or pinned favourites.
- Choose Light, Dark, or System appearance in Settings. Changes fade over 800 ms; System follows the device’s appearance schedule immediately, checks again when the app returns to the foreground, and polls every ten minutes as a fallback. Reduced-motion preferences disable the fade.
- Ask Home Concierge to inspect your home, adjust devices, control Sonos, or open tablet apps.
- Toggle lights, switches, fans, and input booleans; adjust supported light brightness.
- Set supported thermostat temperatures, operate covers, and control music playback, tracks, volume, and mute.
- Run existing Home Assistant scenes from “A whole mood” on the home screen and view sensor readings.
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

| Command                  | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `npm run build`          | Type-check and build the frontend into `dist`                |
| `npm test`               | Run unit tests, including the Home Assistant protocol client |
| `npm run test:e2e`       | Run browser interaction and responsive-layout tests          |
| `npm run tauri -- build` | Build the desktop application and installers                 |

Install the browser needed by the end-to-end tests with `npx playwright install chromium` if it is not already available.

## Connect your home

1. In Home Assistant, open **User profile → Security → Long-lived access tokens** and create a token for Hjem. See [Home Assistant authentication](https://www.home-assistant.io/docs/authentication/).
2. In Hjem, open **Settings** and enter your Home Assistant URL, such as `http://homeassistant.local:8123` or your HTTPS remote address.
3. Paste the token or select **Scan QR code** beside the token field. In Home Assistant’s token dialog, select **Generate QR code**, then point the camera at it. Scanning fills the masked token field; select **Connect Home Assistant** to connect. Hjem discovers supported entities, areas, and existing scenes.

QR scanning uses the native camera on Android and iOS, and the browser camera in HTTPS or localhost previews. Camera permission is requested when scanning starts. You can switch between front and rear cameras, cancel, or enter the token manually. Decoding happens on the device; camera images are not uploaded or saved. The token is saved only after a successful connection. Home Assistant access-token QR codes are supported; login links and two-factor authentication QR codes are not access tokens.

Installed apps save the server and token in a private SQLite database and reconnect automatically after a restart, retrying while the server is temporarily unreachable. **Settings → Forget connection** removes the saved credentials. Switching to the demo disconnects the current session but keeps the saved connection for the next launch. The browser preview keeps its settings and credentials in memory only. Hjem connects directly to your server using the [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/) and does not need an intermediary service.

Use HTTPS for remote access. An HTTP address uses an unencrypted WebSocket connection, so reserve it for a trusted local network. The server must be reachable from the device running Hjem. If you use a reverse proxy, it must forward WebSocket connections to `/api/websocket`. An HTTPS browser preview cannot connect to an HTTP server because browsers block mixed content.

## Today’s calendar

In **Settings → Calendars**, add a name and an iCal/ICS subscription link for each calendar. HTTPS, HTTP, and `webcal://` links are accepted. Multiple calendars merge into today’s view and work without a Home Assistant connection. Hjem saves links in SQLite; no Google account login is required on the shared tablet. Use the check button to verify a feed and the remove button to unsubscribe.

For Google Calendar, open its settings on your own device, select a calendar, choose **Integrate calendar**, and copy its **Secret address in iCal format**. Paste that address into Hjem. Keep private feed links private: they grant read access to the calendar. See [Google’s iCal instructions](https://support.google.com/calendar/answer/37648). Ordinary Google Calendar web-page links are not subscription feeds.

Linked calendars are read only and refresh every five minutes, when Hjem returns to the foreground, and when you select Refresh. Recurrence rules, exclusions, moved/cancelled occurrences, time zones, daylight-saving changes, and all-day events are supported. A failed feed shows an error while other feeds continue to load. Downloads are limited to 2 MiB and 30 seconds, and parsing runs in a bounded worker so a malformed feed cannot freeze the interface. Native apps download directly; browser previews require the feed provider to allow browser access and keep subscriptions only until reload.

Music and the calendar share the top of the home screen, with the full-width mood buttons below. The calendar shows all 24 hours, events sized by duration, overlapping events side by side, and a thicker current-time line that updates every minute. The compact calendar scrolls through the day and glides back to the current-time line shortly after release; reduced-motion settings make the return instant. All-day events sit above the timeline. The home screen reads today’s events from visible, enabled Home Assistant calendar entities using `calendar.get_events`. The day runs from local midnight to the next local midnight on the tablet, including daylight-saving changes. Events refresh when the connection or calendars change, when Hjem returns to the foreground, every five minutes, and on demand. Calendar events are read only; Hjem does not create or change them. Add your preferred calendar integration in Home Assistant to make it appear here. Demo mode uses sample events only when no calendar links are configured.

## Sonos

Add your speakers to the [Sonos integration in Home Assistant](https://www.home-assistant.io/integrations/sonos/). Hjem then discovers their media-player entities alongside your other devices; no separate Sonos account or connection is needed in Hjem.

Speaker cards show the current track and artist, with play/pause, previous/next track, volume, and mute controls when the speaker supports them. Tabs at the top of the home-screen music card switch between systems. The demo includes three independent Sonos systems in the living room, kitchen, and bedroom, each with its own playback, track, and volume. Music selection, queues, and speaker grouping remain in the Sonos app or Home Assistant for this first version.

## Android home screen and apps

On Android, Hjem lists launchable apps in the current profile, using their names and icons from Android. Open **Apps** to search, launch, or pin an app in the drawer’s Pinned view. The list refreshes when you return to Hjem, and pinned choices stay on this device. Apps work independently of your Home Assistant connection. Hold an app to open its options: **App info** opens Android’s settings for that app, and **Uninstall app** opens Android’s uninstall confirmation. You can cancel there; Hjem refreshes the app list when you return. Right-click and Shift+F10 also open the options menu.

Open **Settings → App visibility** to hide unused apps from Hjem. Search by name or package, then turn off the app’s switch. Hidden apps disappear from the app drawer, search, pinned view, and Concierge’s app list. Use the **Hidden** filter in Settings to show them again; their pins are preserved. Visibility choices are saved in SQLite on native platforms, independently for Android and sample apps. Hiding an app does not uninstall it or change Android settings.

To use Hjem as the tablet's home screen, choose **Settings → Choose default home app**, then select **Hjem** in Android's settings. Hjem never changes the default automatically. You can choose your previous launcher from the same Android setting.

The browser, desktop, and iOS versions show clearly labeled sample app shortcuts for exploring the layout. They do not enumerate or launch installed apps. The native launcher uses Android's scoped package visibility for launcher activities; it does not request broad access to every installed package. Work profiles, widgets, and notification badges are outside this first version.

## Home Concierge

In **Settings → Home Concierge**, enter your OpenRouter API key and choose one of three recommended models: Claude Haiku 5.5 for quick, low-cost home controls, GPT-6.1 Terra for multi-step requests, or Claude Sonnet 5.5 for more involved tasks. Save the settings, then open **Concierge**. Choose **Use another model** to enter any other model ID; **Check model** verifies its tool support against the live catalogue. These recommendations were checked against [OpenRouter’s catalogue](https://openrouter.ai/models?supported_parameters=tools) on November 15, 2026. **Test key** checks OpenRouter authentication without buying a model completion; chat requests use your OpenRouter credits.

On native platforms, the key and model are saved in Hjem's private SQLite database and used by Rust. The settings API returns only whether a key exists; it never returns the saved key to the web interface. The database is protected by the app sandbox and file permissions, without database encryption. Android automatic backup is disabled. In the browser preview, both the key and model live only in memory until reload. **Remove key** clears the saved key.

Home Concierge can read current device states and apps, adjust supported lights, switches, thermostats, blinds, and media players, activate requested scenes, and open Android apps. It must discover a device or app before acting, validates actions and ranges locally, and cannot call arbitrary Home Assistant services. Browser app shortcuts remain simulated, as do device controls in demo mode. Messages and the home/app information needed for a request go to OpenRouter and the selected model provider. Home Assistant tokens never enter the conversation.

The loop follows the patterns in Tally's `assistant.ts`/`assistantRunner.ts` and Learn Polish's `agent.rs`/`ai.rs`: paired tool requests/results, visible progress, sequential execution, and preserved partial outcomes. Provider reasoning details are preserved privately between tool rounds without appearing in the chat. A turn is limited to six model requests, up to 8,192 output tokens per request, and twelve tool calls. Stop cancels pending model requests and prevents new actions; a device command already sent may still finish. Unconfirmed actions are not automatically replayed. Runs and conversations survive switching Hjem pages, but the chat is session-only and clears on restart, a changed home connection, or a model change.

## Phone and tablet

The interface adapts to narrow phone screens and wider tablets. Android project files are included under `src-tauri/gen/android`; platform builds still require the Android SDK, NDK, Java, and Rust targets described in the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets).

```sh
npm run android
npm run tauri -- android build
```

The first command runs on a connected device or emulator. The second creates a release build; distribution requires your own signing configuration.

### Android releases

On every push to `main`, the GitHub workflow publishes a signed `Hjem-android.apk` as a rolling `latest` release once the tests and the Android build pass. Each run replaces the previous release. Pull requests and manual runs on other branches build the APK as a workflow artifact without publishing it.

Release signing requires the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` repository secrets; without them, `main` does not publish. Run `./scripts/make-android-keystore.sh` once to create a key and print the four secrets. Keep the keystore and its password safe: later releases must use the same key to upgrade an installed copy. Pull requests sign their test APKs with a temporary key, so those cannot upgrade a released install.

Android release builds support user-configured local HTTP hostnames and LAN IP addresses, including `http://192.168.1.105:8123`, through the committed network security configuration. No address-specific rebuild is needed. HTTPS continues to use the system trust store.

For iPhone and iPad, install full Xcode and `xcodegen`, configure Apple signing, and install the iOS Rust targets from the Tauri prerequisites. The iOS project has not yet been initialized. Then run:

```sh
npm run tauri -- ios init
npm run ios
```

The shared `src-tauri/Info.plist` includes a local-network permission explanation and support for local network connections. Allow local-network access when prompted. See the [Tauri development guide](https://v2.tauri.app/develop/) for device selection and platform tooling.

Real Home Assistant hardware and physical mobile devices have not yet been tested with this project. The included demo and automated tests exercise the interface and simulated Home Assistant/OpenRouter connections. The Android release has also been checked in an isolated emulator with real app discovery, Clock launching, Home-button navigation, HTTP-IP connections to a local fixture, saved-token reconnection after a process restart, and removal of saved credentials. No paid OpenRouter calls are made by the test suite.

## Persisted settings and types

All durable native settings use SQLite through Diesel: Home Assistant credentials, calendar subscriptions, theme, favourites, selected speakers, app pins and visibility, and Concierge credentials/model. Embedded migrations run before the interface opens. Existing browser preferences and the old Concierge JSON file are imported once, transactionally, and removed only after a successful import. An unreadable database or failed migration displays a retryable error without resetting saved data. Chat history and fetched device/calendar state remain session data.

TypeScript runs in strict mode, external payloads are validated from `unknown`, and Rust forbids unsafe code. The build also rejects TypeScript type assertions, `any`, non-null assertions, and Rust casts.

## Project layout

| Path                        | Contents                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `src/`                      | React and TypeScript interface                                       |
| `src/lib/home-assistant.ts` | Authentication, state subscriptions, reconnection, and service calls |
| `src/lib/demo.ts`           | Interactive sample home                                              |
| `public/brand/`             | Original SVG logo, wordmark, and app-icon master                     |
| `src-tauri/`                | Rust application shell, platform configuration, and generated icons  |

Hjem is an independent interface for Home Assistant, not an official Home Assistant application.

## GitHub builds

[Build Hjem](https://github.com/madsbuch/hjem/actions/workflows/build.yml) runs on pushes to `main`, pull requests, and manual dispatch. It checks the frontend, protocol tests, and phone/tablet browser tests, then builds:

- macOS universal DMG (Apple Silicon and Intel), Windows NSIS installer, and Linux DEB/AppImage.
- Android APK for ARM phones and tablets.
- An unsigned iOS simulator app archive. Physical iPhone/iPad installation needs Apple signing.

Download build artifacts from a completed Actions run; artifacts are retained for 14 days. Pushes to `main` also publish the Android APK to the rolling `latest` release after the frontend checks and Android build pass. Desktop bundles are unsigned or ad-hoc signed for testing, without distribution notarization.

For Android installs that can upgrade earlier builds, configure repository Actions secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Without them, CI creates a temporary signing key: the APK installs, but each build requires uninstalling a previous CI build first.
