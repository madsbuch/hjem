# Hjem

**A little more at home.**

Hjem means “home” in Danish. It is a Tauri 2 home screen for an Android tablet, with today’s calendar, Home Assistant scenes, and music on its home screen. Separate Controls and Apps pages keep devices and installed apps within reach. Its home-control interface also runs on phones and desktops. A navy-blue house mark, amber doorway, and cool blue interface give everyday controls a calm, familiar place to live.

Start with the interactive demo home, then connect your own Home Assistant in Settings.

- See today’s events from iCal/ICS subscription links and Home Assistant, including all-day and recurring events.
- Open Controls to browse rooms, adjust devices, and pin favourites.
- Open installed Android apps from a searchable app drawer.
- Browse rooms using your Home Assistant areas and device assignments.
- Search devices and filter by room or pinned favourites.
- See electricity prices by the hour, the cheapest hours, and your use and cost from Osmund.
- Use the Home planner in Settings to pair new Zigbee appliances, name lights and remotes, put them in rooms, blink a lamp to find it, and see which remote you just pressed.
- Choose Light, Dark, or System appearance in Settings. Changes fade over 800 ms; System follows the device’s appearance schedule immediately, checks again when the app returns to the foreground, and polls every ten minutes as a fallback. Reduced-motion preferences disable the fade.
- Open Home setup in Settings to configure the home by talking to Concierge, with the home's rooms, automations, scripts, moods, and helpers shown live beside the conversation.
- Ask Home Concierge to organize rooms and devices, create and maintain moods, set up automations and scripts, adjust devices, control Sonos, or open tablet apps.
- Toggle lights, switches, fans, and input booleans; adjust supported light brightness.
- Set supported thermostat temperatures, operate covers, and control music playback, tracks, volume, and mute.
- Run existing Home Assistant scenes from “A whole mood” on the home screen and view sensor readings.
- Receive live state changes, connection feedback, and automatic reconnection after an interrupted session.

Controls follow the capabilities each entity reports. Hidden and disabled registry entities are excluded. Devices without an area appear together as unassigned. Concierge and the Home planner can manage areas, device names and assignments, and Concierge can manage persistent scenes, automations, scripts, and helpers, through specific validated operations. Cameras, lock controls, integrations, users, dashboards, and general system administration remain outside the current scope.

The principles behind Hjem's design are recorded in [PRINCIPLES.md](PRINCIPLES.md).

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

In **Settings → Calendars**, add a name and an iCal/ICS subscription link for each calendar. HTTPS, HTTP, and `webcal://` links are accepted. Multiple calendars merge into today’s view and work without a Home Assistant connection. Hjem saves links in SQLite; no Google account login is required on the shared tablet. Links are displayed in full. Use the pencil button to edit a saved calendar’s name or URL, **Save changes** to update it in place, or **Cancel edit** to keep the existing values. Events refresh after an edit. Use the check button to verify a feed and the remove button to unsubscribe.

For Google Calendar, open its settings on your own device, select a calendar, choose **Integrate calendar**, and copy its **Secret address in iCal format**. Paste that address into Hjem. Keep private feed links private: they grant read access to the calendar. See [Google’s iCal instructions](https://support.google.com/calendar/answer/37648). Ordinary Google Calendar web-page links are not subscription feeds.

Linked calendars are read only and refresh every five minutes, when Hjem returns to the foreground, and when you select Refresh. Recurrence rules, exclusions, moved/cancelled occurrences, time zones, daylight-saving changes, and all-day events are supported. A failed feed shows an error while other feeds continue to load. Downloads are limited to 2 MiB and 30 seconds, and parsing runs in a bounded worker so a malformed feed cannot freeze the interface. Native apps download directly; browser previews require the feed provider to allow browser access and keep subscriptions only until reload.

Music and the calendar share the top of the home screen, with the full-width mood buttons below. The calendar shows all 24 hours, events sized by duration, overlapping events side by side, and a thicker current-time line that updates every minute. The compact calendar scrolls through the day and glides back to the current-time line shortly after release; reduced-motion settings make the return instant. All-day events sit above the timeline. The home screen reads today’s events from visible, enabled Home Assistant calendar entities using `calendar.get_events`. The day runs from local midnight to the next local midnight on the tablet, including daylight-saving changes. Events refresh when the connection or calendars change, when Hjem returns to the foreground, every five minutes, and on demand. Calendar events are read only; Hjem does not create or change them. Add your preferred calendar integration in Home Assistant to make it appear here. Demo mode uses sample events only when no calendar links are configured.

## Home planner

Open **Settings → Home planner** to add appliances and tidy up names and rooms, one light or remote at a time. It lives under Settings rather than the main menu because it is for occasional setup, not everyday use; **Settings** at the top of the planner returns there. Each card has a name you can edit in place (press Enter or move away to save, Escape to cancel) and a room picker. **Needs a room** shows only what is still unplaced, and **New room** adds a room without leaving the page.

**Lights.** Select **Blink** on a card and the lamp switches off and on three times, then returns to its original on/off state and brightness. Look around the room to see which lamp it is; select **Stop blinking** to end early and restore it. Light groups and hidden lights are left out. A light that is the only light on its device is renamed and placed as that device, as Home Assistant shows it; otherwise the light entity itself is changed. Lights without a unique ID can blink but cannot be renamed by Home Assistant.

**Remotes.** All remotes are shown together, with battery level when the remote reports one. Press a button on any remote and its card glows, shows the button that was pressed, and scrolls into view; the banner above the cards names it too. Remotes are recognised from Home Assistant event entities, Zigbee2MQTT-style `…_action` sensors, device models such as remote, dimmer, or button, and button events from ZHA, deCONZ, Philips Hue, Z-Wave JS, and Lutron Caséta. A device that sends one of those button events appears as soon as it is pressed, even if it was not recognised before. The demo home includes three remotes and a **Simulate a press** button.

**Adding appliances.** Select **Add appliance** to pair a new Zigbee bulb, remote, or other device. The panel gives reset steps for IKEA bulbs and remotes and a tip for placing a USB Zigbee dongle such as Sonoff's, then **Start pairing** opens the Zigbee network for 4 minutes 14 seconds (the longest both Zigbee stacks allow), or until **Stop pairing**. Each appliance that joins appears in the panel straight away, where you can name it, put it in a room, and blink a new bulb to check which one it is. It moves into the Lights or Remotes list when you close the panel. Leaving the Home planner stops pairing.

Hjem pairs through Home Assistant, using whichever Zigbee setup it finds there: ZHA (through Home Assistant's `zha/devices/permit` command) or Zigbee2MQTT (by publishing to `zigbee2mqtt/bridge/request/permit_join` through the MQTT integration, so a custom base topic is not supported yet). When it can't tell, or finds both, it asks which one to use. Pairing needs administrator access. The demo home adds a sample appliance a few seconds after pairing starts.

Renames and room changes are written to Home Assistant's device and entity registries, need administrator access, and appear in **Recent setup changes** under Concierge, where they can be undone. Blinking sends ordinary light commands; nothing else in Home Assistant is changed.

## Home setup

Open **Settings → Home setup** to configure the home without filling in forms. The screen is split in two: Concierge takes a third, and the rest shows the home as Home Assistant has it right now. Say what you want ("when the front door opens after dark, turn on the hallway lamp", "make the top button on the bedroom remote dim the bedside lamp", "why didn't the wake-up automation run this morning?") and watch the result appear on the right. On a phone or a narrow window, **Concierge** and **Your home** at the top switch between the two sides.

The home side has six tabs:

- **Rooms:** each room with its devices and what they are doing now, updating live.
- **Automations:** each automation in plain language (*When* the front door opens, *Only if* it is after sunset, *Then* turn on the reading lamp at 60%), whether it is on or paused, when it last ran, and any device it uses that is missing or not responding. **Configuration** shows what is saved in Home Assistant.
- **Scripts:** named lists of actions, described the same way.
- **Moods:** what each mood sets.
- **Helpers:** the small values automations read, such as a wake-up time or a guest-mode switch.
- **Changes:** everything changed during this session, each with **Undo**.

When Concierge changes something, the home side switches to it and outlines it for a few seconds. **Ask** on any card starts a message about that room, automation, script, or mood. The home side is for looking; changes go through the conversation, and **Undo** is the one direct control.

Concierge can create, change, pause, run, and delete automations and scripts, create and change helpers, rename devices, hide entities from Hjem's controls, and delete empty rooms, in addition to the room and mood setup described under [Home Concierge](#home-concierge). Before it writes an automation that starts from a remote or sensor, it asks Home Assistant what that device can trigger, so button names are not guessed. To explain a routine that misbehaves, it reads the routine and the recent runs Home Assistant has stored.

Every automation and script is checked before it is saved:

- Each device, entity, and room it names must exist in the home. A guessed identifier is refused with the reason, and Concierge corrects it.
- Home Assistant validates the triggers, conditions, and actions (Home Assistant 2024.10 or later; on older versions the save itself is the check).
- Routines run unattended, so their actions cannot operate locks or alarm panels, or call system services such as shell commands, add-ons, backups, MQTT publishing, or a restart. Triggers and conditions may still read a lock or alarm, for example to light the hall when the door is unlocked. Service names must be written out; templated service names are refused.
- Changing or deleting an existing routine requires reading it first, and is refused if it was edited elsewhere in the meantime.

Automations, scripts, and helpers are saved in Home Assistant, because Home Assistant is what runs them; they keep working when the tablet is off, and appear in Home Assistant's own editors. Automations and scripts written in Home Assistant's YAML files without an id can be read about and run but not changed from Hjem. Saving needs administrator access. Each change can be undone from **Changes** while the home session stays open: a created routine is removed, a changed one gets its previous definition back, and a deleted one is restored, unless it was edited elsewhere after Hjem's change. Running a routine really changes devices, and Concierge only does so when asked.

The demo home includes three automations, a script, and a helper, and everything on this screen can be tried there. Demo routines are simulated; running one applies its plain device steps to the demo devices.

## Electricity

**Electricity** shows your electricity from [Osmund](https://osmundenergi.dk), read through the Osmund API:

- **Right now:** the price for the current hour in kr/kWh incl. VAT, and whether that is cheap, average, or expensive compared with the rest of today.
- **Cheapest 3 hours:** the cheapest three consecutive hours that have not started yet, across today and tomorrow, for running the dishwasher or charging.
- **Prices by the hour:** a chart of today's prices, and tomorrow's once Osmund publishes them in the afternoon. Tap or hover a bar to see the spot price, tariffs, and taxes behind it; **Show as a table** lists every hour.
- **This month so far:** cost including subscriptions, kWh used, and a straight-line estimate for the whole month.
- **Your use:** kWh per day for the last two weeks. Meter readings arrive a day later.
- **With everything off:** the standby draw for the last full month, and what that adds up to in a year.
- **Latest invoice:** amount, and whether it is paid or when it is due.

To connect, create an API key on Min side at osmundenergi.dk (API access is part of Osmund Pro), then open **Settings → Electricity** and paste it. Hjem checks the key with Osmund before saving it. If the account has one location with API access, it is chosen automatically; otherwise choose it from the list. The key is stored in Hjem's private SQLite database, only the native app sends it, and only to `api.osmundenergi.dk`; the interface never receives it. Hjem calls a fixed set of read-only routes: locations, prices, consumption, standby, rated cost, and invoices. **Remove key** forgets the key and location.

Hjem loads six requests when the page opens, then every hour, at the start of a new day, and when the app returns to the foreground, never more often than every five minutes. That is far inside Osmund's limits of 60 requests a minute, 120 an hour, and 1000 a day. Each section loads on its own, so if one part is unavailable, such as standby for a location without enough readings, the rest still shows. The Osmund API is in beta; Hjem ignores fields it does not know.

The demo home and the browser preview show clearly labelled sample prices shaped like a winter day in DK1.

Home Concierge can answer questions such as “When should I run the dishwasher before 7?”, “Is power cheap right now?”, or “What has November cost so far?”. It has three read-only tools: hourly prices for today and tomorrow with their parts, the cheapest hours for a task (one block or separate hours, with an earliest start and a deadline, worked out by Hjem rather than estimated by the model), and use and cost day by day, including the share of fixed subscriptions and the days Osmund has not costed yet. They read the data the Electricity page has already loaded, so asking makes no extra Osmund requests. Concierge cannot schedule devices to run later; it suggests a time instead. The prices and use needed for an answer are sent to OpenRouter with the request; the Osmund key never is.

## Hjem hub

The Hjem hub is a small service that runs beside Home Assistant on the Raspberry Pi. Tablets, phones, and computers connect to the hub instead of to Home Assistant, and each of them keeps a full copy of the home.

**Install.** In Home Assistant, open **Settings → Add-ons → Add-on store** (called Apps in recent versions), choose **Repositories** from the menu, and add `https://github.com/madsbuch/hjem`. Install **Hjem hub** and start it. Home Assistant offers each new version as an update. Nothing is configured on the Raspberry Pi itself. The add-on needs Home Assistant OS or a supervised installation.

**Connect a device.** Select **Open web UI** on the add-on to see its pairing code. In Hjem, open **Settings → Home Assistant → Connect your home**, enter the hub's address, such as `http://homeassistant.local:8099`, and the pairing code in place of an access token. Settings then shows **Through: Hjem hub**. The same code pairs every device, no Home Assistant token is created or stored on any of them, and anyone with the code can control the home from your network. Ten wrong codes from one address pause pairing from that address for ten minutes.

**What a device can do through the hub.** Everything it can do connected directly: live state, controls, the Home planner, Home setup, and Concierge. The hub passes on only the Home Assistant commands Hjem uses and the three editor endpoints for moods, automations, and scripts; any other command or path is refused by the hub and never reaches Home Assistant.

**A copy of the home on every device.** The hub keeps one numbered copy of the home: rooms, the names and rooms of devices, moods, automations, scripts, and helpers, with devices identified by hardware identity. It reads the home again when something changes and every 15 minutes, and sends each new copy to every connected device straight away. A device stores the latest five copies per hub, with its own Hjem settings added. A copy is only ever replaced by a complete one: if part of the home cannot be read, the previous copy stays.

**Restoring.** If the hub or the Raspberry Pi is replaced, install the add-on again, pair a device that was connected before, and open **Settings → Move or back up your home → Restore from this device**. Choose a copy, check the preview, and import. It works like importing a file: it creates what is missing, never deletes, and can be run again after pairing more appliances. Automations and scripts are pointed at the new server's devices by hardware identity and are checked again before they are saved. Once restored, the new hub's own copy catches up and reaches every other device.

Not part of a copy yet: access tokens and the OpenRouter and Osmund keys, and the Zigbee network itself, which Home Assistant's own backup carries. Copies on a device are kept in the app's own storage. The hub is reached on the home network only, and devices are not discovered automatically; the address is typed once.

The hub can also run without Home Assistant OS, as a container or with Node.js 22: build it with `npm run build:hub`, then run `hjem-hub/dist/hub.mjs` with `HJEM_HA_URL` and `HJEM_HA_TOKEN` set to a Home Assistant address and an administrator's long-lived token, and `HJEM_DATA` to a folder it can write to. The pairing code is printed in its log.

To release a new version of the add-on, raise `version` in `hjem-hub/config.yaml`. The build on `main` publishes the image `ghcr.io/madsbuch/hjem-hub` under that version for 64-bit ARM and x86. The package must be public on GitHub for Home Assistant to download it.

## Moving or backing up your home

**Settings → Move or back up your home → Export configuration** saves a JSON file with your rooms, the names and rooms of your lights, remotes, and other devices, your moods, automations, scripts, and helpers, and Hjem's settings: appearance, calendar links, pinned devices, music speaker, hidden and pinned apps, and the Concierge model. On Android you choose where to save it, such as Downloads or a cloud drive; the browser preview downloads it. Access tokens and the OpenRouter key are never included. Calendar links are, so keep the file private.

**Import configuration** reads a file, shows what it will change, and applies it only after you confirm. Each change goes through the same validated setup steps as the Home planner, so it appears in **Recent setup changes** under Concierge and can be undone. Import only adds and updates: it creates missing rooms, restores names and rooms, creates moods, helpers, scripts, and automations that don't exist yet, and merges settings. It never deletes anything, and running it twice is safe.

Devices are matched by hardware identity, not by Home Assistant's internal IDs, which change on a new server. Zigbee devices are matched by their IEEE address, whether they use ZHA or Zigbee2MQTT. Other devices use their integration's identifier, or their default name as a last resort. Devices that aren't on the new server yet are listed in the preview; pair them with **Add appliance** in the Home planner, then import the same file again.

### Moving to a new Raspberry Pi

1. In Hjem, export the configuration.
2. Move Home Assistant itself. Its own backup (**Settings → System → Backups** in Home Assistant) carries integrations, automations, and the Zigbee network. Restoring that backup on the new Raspberry Pi, with the same Sonoff dongle plugged in, keeps your devices paired. If you start Home Assistant from scratch instead, pair each appliance again with **Add appliance**.
3. In Hjem, connect to the new server, then import the configuration. Names, rooms, and moods come back for every device it finds.

Hjem's own settings stay on the tablet when only the Raspberry Pi changes, except pinned devices and the music speaker, which Hjem keeps per server; importing with **Also restore Hjem's settings** brings them to the new one. All settings in the file matter when you set up Hjem on a new tablet.

## Sonos

Add your speakers to the [Sonos integration in Home Assistant](https://www.home-assistant.io/integrations/sonos/). Hjem then discovers their media-player entities alongside your other devices; no separate Sonos account or connection is needed in Hjem.

Speaker cards show the current track and artist, with play/pause, previous/next track, volume, and mute controls when the speaker supports them. Tabs at the top of the home-screen music card switch between systems. The demo includes three independent Sonos systems in the living room, kitchen, and bedroom, each with its own playback, track, and volume. Music selection, queues, and speaker grouping remain in the Sonos app or Home Assistant for this first version.

## Android home screen and apps

On Android, Hjem lists launchable apps in the current profile, using their names and icons from Android. Open **Apps** to search and launch an app. The list refreshes when you return to Hjem. Apps work independently of your Home Assistant connection. Hold an app to open its options: **App info** opens Android’s settings for that app, and **Uninstall app** opens Android’s uninstall confirmation. You can cancel there; Hjem refreshes the app list when you return. Right-click and Shift+F10 also open the options menu.

Open **Settings → App visibility** to hide unused apps from Hjem. Search by name or package, then turn off the app’s switch. Hidden apps disappear from the app drawer, search, and Concierge’s app list. Use the **Hidden** filter in Settings to show them again. Visibility choices are saved in SQLite on native platforms, independently for Android and sample apps. Hiding an app does not uninstall it or change Android settings.

To use Hjem as the tablet's home screen, choose **Settings → Choose default home app**, then select **Hjem** in Android's settings. Hjem never changes the default automatically. You can choose your previous launcher from the same Android setting.

The browser, desktop, and iOS versions show clearly labeled sample app shortcuts for exploring the layout. They do not enumerate or launch installed apps. The native launcher uses Android's scoped package visibility for launcher activities; it does not request broad access to every installed package. Work profiles, widgets, and notification badges are outside this first version.

## Home Concierge

In **Settings → Home Concierge**, enter your OpenRouter API key and browse the full live OpenRouter catalogue. Search by name or model ID, filter by provider, output capability, tool support, or free pricing, and sort by price, context length, or newest. All models remain browseable, including models without text or tool support; only compatible models can be selected for Concierge. Prices and availability come from OpenRouter, with unknown prices marked explicitly.

Three recommended starting points are shown above the catalogue: Claude Haiku 5.5 for quick, low-cost home controls, GPT-6.1 Terra for multi-step requests, and Claude Sonnet 5.5 for more involved tasks. These recommendations were checked against [OpenRouter’s catalogue](https://openrouter.ai/models?supported_parameters=tools) on November 15, 2026. Select a model and save the settings, then open **Concierge**. **Use another model** still accepts a model ID directly; **Check model** verifies its text and tool support. **Test key** checks OpenRouter authentication without buying a model completion; chat requests use your OpenRouter credits.

Concierge replies render Markdown, including headings, lists, emphasis, tables, links, and code. Raw HTML is ignored and image URLs are shown as links. The conversation and setup history scroll inside the chat panel, while the heading and message composer remain in place.

**Chat history** lists every saved conversation, newest first, with search by title or model. Open a chat to read it or continue it; **New conversation** keeps earlier chats in the archive. Visible messages, replies, progress and errors save automatically to the private SQLite database on native platforms and IndexedDB in the browser preview. The latest conversation for the current home reopens after restart, even without an OpenRouter key. Chats belonging to another home remain readable but cannot control the current home. Saved chats provide text context only: reopening never replays old tool calls or restores microphone recordings. Chats erased before this persistence feature was installed cannot be recovered. A save failure appears in the conversation with **Retry saving**; keep Hjem open until the retry succeeds.

Tap the microphone beside the message field to record a voice message, then tap Send; recordings are limited to 30 seconds. Voice uses the full `openai/gpt-audio` model through OpenRouter, independently of the selected text model. Replies play as streamed audio and their text appears in the conversation. Voice requests use the same validated home tools as typed requests. Stop cancels the request and playback; Cancel discards an unsent recording. Leaving Concierge or backgrounding Hjem releases the microphone and stops voice playback. The first recording asks for microphone permission. Voice recordings remain session-only, are sent to OpenRouter for the spoken turn, and are retained for up to four recent conversational turns; they are never saved to disk.

OpenRouter [does not expose the Realtime WebSocket API](https://openrouter.ai/docs/guides/features/compatibility). Hjem therefore sends completed microphone turns and streams the spoken response using [Audio Chat Completions](https://openrouter.ai/docs/guides/overview/multimodal/audio), rather than offering a full-duplex realtime session. Voice requests incur GPT Audio's audio rates in addition to text/tool tokens.

On native platforms, the key and model are saved in Hjem's private SQLite database and used by Rust. The settings API returns only whether a key exists; it never returns the saved key to the web interface. The database is protected by the app sandbox and file permissions, without database encryption. Android automatic backup is disabled. In the browser preview, both the key and model live only in memory until reload. **Remove key** clears the saved key.

Home Concierge can read current device states, apps, and electricity prices and use, adjust supported lights, switches, thermostats, blinds, and media players, activate requested scenes, set up automations, scripts, and helpers (see [Home setup](#home-setup)), and open Android apps. It must discover a device or app before acting, validates actions and ranges locally, and cannot call arbitrary Home Assistant services itself. Browser app shortcuts remain simulated, as do device controls in demo mode. Messages and the home, app, and electricity information needed for a request go to OpenRouter and the selected model provider. Home Assistant tokens never enter the conversation.

### Rooms and moods

Ask “Create an office and move the reading lamp there,” “Rename the spare bedroom to the nursery,” or “Set up a cosy evening mood.” **Controls → Organize rooms** and **A whole mood → Set up a mood** open a starting message in Concierge. It discovers current rooms, physical devices, and individual entities before changing anything, and asks about ambiguous devices using their names. Room changes preserve explicit entity overrides. Unassigned resources and empty rooms are included, and registry changes refresh without reconnecting.

Home Assistant administrator access is required for configuration changes. The existing Hjem connection is used; tokens are never passed to the model. Rooms and assignments use Home Assistant’s registry APIs. Moods are saved through the scene editor’s persistent configuration API, so they survive Home Assistant restarts and are available outside Hjem. Installed apps make scene HTTP requests through a bounded native transport restricted to the saved home; browser previews require Home Assistant to allow their origin. Automations and scripts use the matching editor APIs through the same bounded transport. No configuration files or arbitrary service endpoints are exposed to Concierge.

Mood authoring supports on/off settings, supported brightness and colour temperature, thermostat targets, blind positions, and supported playback/volume/mute settings. Existing editable scenes must be inspected before updates. Unsupported integration scenes can still be activated, but Hjem reports when their results cannot be verified. Activating an inspectable mood checks observable device states and reports unconfirmed settings instead of treating an accepted command as proof that every device changed. Saving a mood does not activate it.

Ask Concierge to undo a setup change, or use **Recent setup changes** beneath the conversation. The last 30 setup changes retain their previous configuration while the home session stays open. Undo checks for changes made elsewhere before restoring anything; a newly created room can only be removed if it is still empty and unreferenced. Undo changes configuration, not past physical device states. History clears when switching home connections or restarting Hjem; the configuration saved in Home Assistant remains. Demo setup and moods are simulated and last for the demo session. Moving devices reports known related routines because room-targeted automations may include different devices after a move. Adding integrations is not part of this version.

The loop follows the patterns in Tally's `assistant.ts`/`assistantRunner.ts` and Learn Polish's `agent.rs`/`ai.rs`: paired tool requests/results, visible progress, sequential execution, and preserved partial outcomes. Provider reasoning details are preserved privately in memory between tool rounds without appearing in the chat. A turn is limited to sixteen model requests, up to 8,192 output tokens per request, and thirty-six tool calls, enough to read the home, write a routine, and correct it if Home Assistant refuses it. Stop cancels pending model requests and prevents new actions; a device command already sent may still finish. Unconfirmed actions are not automatically replayed. Typed requests and conversations survive switching Hjem pages; active voice capture and playback stop when leaving Concierge. Changing the home connection or text model starts a new conversation and preserves previous chats in Chat history.

## Phone and tablet

The interface adapts to narrow phone screens and wider tablets. Android project files are included under `src-tauri/gen/android`; platform builds still require the Android SDK, NDK, Java, and Rust targets described in the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets).

```sh
npm run android
npm run tauri -- android build
```

The first command runs on a connected device or emulator. The second creates a release build, signed when the local Android signing configuration below is present.

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

All durable native settings use SQLite through Diesel: Home Assistant credentials, calendar subscriptions, theme, favourites, selected speakers, app visibility, and Concierge credentials/model. Embedded migrations run before the interface opens. Existing browser preferences and the old Concierge JSON file are imported once, transactionally, and removed only after a successful import. An unreadable database or failed migration displays a retryable error without resetting saved data. Chat history and fetched device/calendar state remain session data.

TypeScript runs in strict mode, external payloads are validated from `unknown`, and Rust forbids unsafe code. The build also rejects TypeScript type assertions, `any`, non-null assertions, and Rust casts.

## Project layout

| Path                        | Contents                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `src/`                      | React and TypeScript interface                                       |
| `src/lib/home-assistant.ts` | Authentication, state subscriptions, reconnection, and service calls |
| `src/lib/demo.ts`           | Interactive sample home                                              |
| `public/brand/`             | Original SVG logo, wordmark, and app-icon master                     |
| `src-tauri/`                | Rust application shell, platform configuration, and generated icons  |
| `hub/`                      | The Hjem hub service, sharing the home logic in `src/lib/`           |
| `hjem-hub/`                 | The hub packaged as a Home Assistant add-on                          |

Hjem is an independent interface for Home Assistant, not an official Home Assistant application.

## GitHub builds

[Build Hjem](https://github.com/madsbuch/hjem/actions/workflows/build.yml) runs on pushes to `main`, pull requests, and manual dispatch. It checks the frontend, protocol tests, and phone/tablet browser tests, then builds:

- macOS universal DMG (Apple Silicon and Intel), Windows NSIS installer, and Linux DEB/AppImage.
- Android APK for ARM phones and tablets.
- An unsigned iOS simulator app archive. Physical iPhone/iPad installation needs Apple signing.

Download build artifacts from a completed Actions run; artifacts are retained for 14 days. Pushes to `main` also publish the Android APK to the rolling `latest` release after the frontend checks and Android build pass. Desktop bundles are unsigned or ad-hoc signed for testing, without distribution notarization.

### Android signing

The persistent Android release key is stored in the ignored `.signing/hjem-release.jks`, with its credentials in `.signing/signing.json` and certificate fingerprint in `.signing/certificate.sha256`. A complete copy is saved in the workspace's `signing-keys/hjem/` folder. Back up that folder privately; keep the same key for all future updates.

Local release builds load the ignored `src-tauri/gen/android/keystore.properties` file, containing `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. `storeFile` can be absolute or relative to `src-tauri/gen/android`. Restore the values from `.signing/signing.json` when setting up another machine, and restrict the keystore and credential files to your account. If this properties file is absent, the local release build is unsigned; incomplete credentials or a missing keystore cause configuration to fail.

GitHub Actions uses repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` for the same key. The workflow signs and verifies the APK after building it. Missing secrets block publication from `main`; non-main test builds use a temporary signing key.

APKs signed with this persistent key can upgrade one another. An earlier APK signed with a temporary CI key must be uninstalled before installing the first build signed with the persistent key; uninstalling clears its local app data.
