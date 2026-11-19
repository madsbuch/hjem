# Hjem hub

The hub sits between Hjem on your devices and Home Assistant. Devices pair with the hub using one code instead of each needing a Home Assistant access token, and every device receives a full copy of your home that it can restore from.

## Connect a device

1. Start the add-on, then select **Open web UI**. The page shows the pairing code.
2. In Hjem, open **Settings → Home Assistant → Connect your home**.
3. As the address, enter this Home Assistant's address with port 8099, for example `http://homeassistant.local:8099`.
4. In the token field, enter the pairing code. Capital letters and dashes do not matter.

The same code pairs every device. Anyone who has it can control your home from your network, so treat it like a password. The code is only shown inside Home Assistant and in the add-on's log.

## What the hub does

- **Relays Hjem's requests to Home Assistant.** Only the commands Hjem itself uses are passed on; anything else is refused by the hub.
- **Keeps a numbered copy of your home**: rooms, the names and rooms of devices, moods, automations, scripts, and helpers. It is read again whenever the home changes and every 15 minutes, and saved in the add-on's data.
- **Sends each new copy to every connected device.** A device keeps the latest five. If the hub or the Raspberry Pi is replaced, open **Settings → Move or back up your home → Restore from this device** in Hjem on any device.

A copy is only replaced by a complete one. If Home Assistant cannot be read fully, the previous copy stays and the log says so.

## Changing the port

The hub listens on port 8099. Change the host port under **Configuration → Network** if something else uses it, and use the new port in Hjem.

## Not included yet

- Access tokens and API keys are not part of the copy.
- The Zigbee network itself is not part of the copy. Home Assistant's own backup carries it.
- The hub is reached on your home network only.
