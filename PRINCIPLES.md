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
