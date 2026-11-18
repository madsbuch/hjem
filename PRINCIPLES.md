# Principles

These principles guide how Hjem is designed and built. When a change conflicts with one of them, change the design, or change the principle on purpose. Don't drift from it quietly.

## 1. Hjem owns the home setup

Hjem is the source of truth for how the home is set up: rooms, what each light, remote, and device is called, which room it belongs to, and the moods built from them.

Home Assistant and other integrations provide access to devices: discovering them, reporting their state, and carrying out commands. They do not decide what the home looks like in Hjem.

In practice:

- Setup state lives in Hjem's own storage. It is not read back from an integration's registry and treated as authoritative.
- An integration's names and areas are only a starting point when a device is first seen. After that, Hjem's record wins.
- Devices are tied to Hjem's records by stable identifiers, so a renamed or reorganised Home Assistant installation does not change the home in Hjem.
- Changing the setup never requires administrator access to an integration.

## 2. Built for a Zigbee home with IKEA bulbs and remotes first

The home Hjem is made for runs Zigbee through a Sonoff Zigbee dongle on a Raspberry Pi running Home Assistant, mostly with IKEA bulbs and remotes. Features are designed and tested against that setup first: pairing steps, button events, and device names should feel right for IKEA hardware. Other brands and protocols are welcome as long as they don't make the main setup harder to use.

Everything about the home, including adding new appliances, can be done from Hjem without opening Home Assistant.
