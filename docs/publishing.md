# Publishing to npm

The package name is `@skarian/codex-router`. Its installed command is `codex-router`.
The public package uses the MIT license.

## Package contents

Git tracks source, tests, examples, and documentation. It ignores all of `dist`.
The npm package contains compiled runtime files, documentation, and the ESP32 example.
It excludes TypeScript tests, development dependencies, and local configuration.

The `prepare` script builds the project during a source install, `npm pack`, or `npm publish`.
Registry users receive compiled JavaScript. They do not need TypeScript or a source build.
The `prepublishOnly` script runs the automated tests before publication.
See the [npm lifecycle reference](https://docs.npmjs.com/cli/v11/using-npm/scripts/) for script order.

## Verify a release

Use a clean checkout so obsolete build files cannot enter the package.

```sh
npm ci
npm test
npm pack --dry-run
npm pack
```

Inspect the package list. It must contain `dist/src/cli.js`, the runtime modules, `README.md`, and `LICENSE`.
It must not contain `dist/test`, credentials, private keys, or local gateway state.
The [npm package file rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files) define the allowlist behavior.

Install the generated archive in a temporary global prefix:

```sh
npm install --global --prefix /absolute/path/to/test-prefix ./skarian-codex-router-0.1.0.tgz
```

Use the archive name for the selected version.
On macOS and Linux, the executable is under `<prefix>/bin/codex-router`.
On Windows, use `<prefix>\codex-router.cmd`.

Run `agents list --json` with an isolated configuration through that executable.
Verify a gateway startup with temporary state before using the package with a live configuration.
Do not start a second gateway against an existing state directory.

## Configure GitHub trusted publishing

The workflow is `.github/workflows/publish.yml`.
It verifies packages on main, pull requests, and manual runs. Only version tags can publish.

Open the package settings on npm and add a GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `Skarian` |
| Repository | `codex-router` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed actions | Allow direct publication with `npm publish` |

The package must exist before this package-settings configuration is available.
An initial manual release can require npm login and browser 2FA.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for setup details.

The publish job uses an OIDC identity and requests provenance. No npm token secret is required.
GitHub Actions use exact commit hashes. Node and npm use exact versions.
`npm ci` installs dependencies from the lockfile.

## Release a version

Start from a clean main checkout:

```sh
git switch main
git pull --ff-only
npm version patch
git push origin main --follow-tags
```

Use `minor` or `major` for a larger release.
`npm version` updates the package files and creates a commit and version tag.
The workflow requires the tag to match `package.json` and its commit to belong to main.

The verification job runs tests, builds a package, and installs its archive into an isolated prefix.
The publish job starts only after verification passes. Ordinary main pushes never publish.

Inspect the workflow result, then verify the registry version:

```sh
npm view @skarian/codex-router version
```

Users can pin a release explicitly:

```sh
npm install --global @skarian/codex-router@0.1.0
```

Do not move a published release tag or reuse an npm version.
If publication fails, inspect the job before choosing whether to rerun it or create a new version.
