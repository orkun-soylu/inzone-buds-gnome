# Security policy

## Supported versions

Only the latest commit on `main` is supported. There are no release branches
and fixes are not backported.

## Reporting a vulnerability

**Please do not report a vulnerability in a public issue or pull request.**

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/orkun-soylu/inzone-buds-gnome/security/advisories/new)**
(the repository's *Security* tab → *Advisories* → *Report a vulnerability*).
Only the maintainer sees the report.

Please include the commit you tested, your distribution and GNOME Shell version,
steps to reproduce, and what an attacker gains and what access they need first.

## What to expect

This is a single-maintainer hobby project, so replies are best effort rather
than on a fixed timeline. If the issue is confirmed it is fixed on `main` and a
GitHub security advisory is published that credits you, unless you prefer not
to be named. Please keep the details private until the fix is out.

## Scope

The extension runs inside the `gnome-shell` process with the logged-in user's
privileges and talks to the INZONE Buds dongle over `/dev/hidraw`. In scope:

- input from the device (or from anything posing as it on USB) that crashes or
  hangs GNOME Shell, or makes the extension act on data it should reject;
- the udev rule granting hidraw access to more users or devices than intended;
- the install and uninstall steps in the `Makefile` and `wireplumber/` doing
  something unsafe, such as writing outside the paths they document.

Out of scope: anything that already requires root or the ability to run code as
the logged-in user, and physical attacks on the device itself.

The protocol tools in `tools/` are research aids that are run by hand, usually
with `sudo`. Malformed device input making them crash is not a vulnerability;
making them write to anything other than the selected hidraw node is.
