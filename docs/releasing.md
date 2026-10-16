# Releasing Nib

**Status:** current · verified 2026-10-16 · covers npm and Homebrew distribution

## npm

Releases are tagged as `vX.Y.Z`; the published GitHub Release must point at
that tag and its `package.json` must contain matching `X.Y.Z`. The
`verify-release.yml` workflow then installs, typechecks, tests, builds, packs,
installs that exact tarball in an isolated prefix and runs `nib doctor`. It
does not publish: npm publication is manual, with npm 2FA.

From a clean checkout of the release tag:

```bash
tarball="$(npm pack --json | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data)[0].filename))")"
prefix="$(mktemp -d)"
npm install --prefix "$prefix" "$tarball"
"$prefix/node_modules/.bin/nib" doctor
npm publish "$tarball" --access public --tag latest
```

**Release candidates.** A version with a prerelease suffix (`X.Y.Z-rc.N`) is
published with `--tag next` instead of `--tag latest`, so
`npm i -g @amenski/nib` keeps installing the latest stable release and testers
opt in with `npm i -g @amenski/nib@next`. Publish it as a GitHub *prerelease*.
Do not update the Homebrew tap for a release candidate.

## Homebrew tap

`packaging/homebrew/nib.rb.template` is intentionally not a usable formula:
its `VERSION` and `SHA256` placeholders prevent an unpublished or guessed
artifact from being installed.

After the npm publication is available:

1. Download `https://registry.npmjs.org/@amenski/nib/-/nib-X.Y.Z.tgz` and
   calculate its SHA-256.
2. Copy the template into the separate `amenski/homebrew-tap` repository as
   `Formula/nib.rb`, replacing both placeholders with the published version
   and checksum.
3. In that tap, run `brew audit --strict amenski/tap/nib` and
   `brew test amenski/tap/nib`, then commit and push the formula.

Only after the tap change is published may the Homebrew installation command be
presented as available.
