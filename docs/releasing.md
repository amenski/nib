# Releasing Nib

**Status:** current · verified 2026-09-15 · covers npm and Homebrew distribution

## npm

Releases are tagged as `vX.Y.Z`; the published GitHub Release must point at
that tag and its `package.json` must contain matching `X.Y.Z`. The
`publish-npm.yml` workflow then installs, typechecks, tests, builds, packs,
installs that exact tarball in an isolated prefix, runs `nib doctor`, and
publishes the same tarball with npm Trusted Publishing. It uses GitHub-hosted
Node 24 with the bundled modern npm CLI and disabled package-manager caching.

The first publication of `@amenski/nib` is a manual npm/2FA bootstrap:

```bash
tarball="$(npm pack --json | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data)[0].filename))")"
prefix="$(mktemp -d)"
npm install --prefix "$prefix" "$tarball"
"$prefix/node_modules/.bin/nib" doctor
npm publish "$tarball" --access public
```

Configure npm Trusted Publishing for `amenski/nib` and the
`publish-npm.yml` workflow (allow direct `npm publish`) after the package
exists. Do not add an npm token to this repository or to GitHub Actions. When
the corresponding GitHub Release is published, the workflow computes the local
tarball's sha512 integrity and compares it exactly to npm's `dist.integrity`;
it skips only on a match. Later releases publish the smoke-tested tarball by
OIDC from the workflow.

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
