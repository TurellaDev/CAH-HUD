cah-hud Resource Repository
========================

This repository contains the source code and release files for the cah-hud resource, a modular HUD for HogwartsMP servers.

What's Included:
- Source code: TypeScript source under cah-hud/src/
- Built binaries: JavaScript bundles and HTML files under cah-hud/dist/
- Configuration example: cah-hud/data/example.json
- Type definitions: cah-hud/types.d.ts
- Package manifest: cah-hud/package.json
- Documentation: cah-hud/README.md (internal resource docs)

Dependencies:
This resource depends on the following HMP Foundations resources (all version 0.8.1):
- hmp-lib
- hmp-core
- hmp-spawn
- hmp-inventory
- hmp-progression
- hmp-world
- hmp-blips
Note: hmp-world and hmp-blips are also required (version 0.8.1) but are not edited; please obtain them from the official HMP Foundations repository.

Edited versions of these resources are included in this repository (see the folders hmp-lib, hmp-core, hmp-spawn, hmp-inventory, hmp-progression). For a clean server, copy these folders into the server's resources/ directory.

Installation:
1. Copy the entire cah-hud folder into your server's resources/ directory.
2. (Optional) Copy cah-hud/data/example.json to data/cah-hud.json and adjust as needed.
3. Ensure the dependency resources are installed and configured.
4. Restart your server.

Building from Source:
To rebuild the resource from source:

cd cah-hud
npm ci
npm run build   # or whatever build script is defined

(Check cah-hud/package.json for available scripts.)

Version:
This repository represents version 0.8.1 of the cah-hud resource.

License:
Refer to the LICENSE file in the HogwartsMP repository or the resource's internal documentation.

---
Note: This resource is part of the HogwartsMP ecosystem and requires the MafiaHub C++ Framework.

## Included Dependencies (edited)
- hmp-lib (version 0.8.1)
- hmp-core (version 0.8.0)
- hmp-spawn (version 0.8.0)
- hmp-inventory (version 0.8.1)
- hmp-progression (version 0.8.1)

## SQL File

The \sql/cah-hud_changes.sql\ file contains placeholder SQL statements that may be required if you have edited the HMP Foundations tables to support the HUD. Please review and adjust according to your specific edits.

## English Documentation

An English version of the cah-hud documentation is available at \cah-hud/README.en.md\.
