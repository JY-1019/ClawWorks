// Sync Plugin Versions script supports OpenClaw repository automation.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  clawworks?: {
    upstream?: {
      version?: string;
    };
  };
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openclaw?: {
    install?: {
      minHostVersion?: string;
    };
    compat?: {
      pluginApi?: string;
    };
    build?: {
      openclawVersion?: string;
    };
  };
};

type SyncPluginVersionsOptions = {
  write?: boolean;
};

const OPENCLAW_VERSION_RANGE_RE = /^>=\d{4}\.\d{1,2}\.\d{1,2}(?:[-.][^"\s]+)?$/u;
const UPSTREAM_VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:[-.][^"\s]+)?$/u;

function syncOpenClawDependencyRange(
  deps: Record<string, string> | undefined,
  targetVersion: string,
): boolean {
  const current = deps?.openclaw;
  if (!current || current === "workspace:*" || !OPENCLAW_VERSION_RANGE_RE.test(current)) {
    return false;
  }
  const next = `>=${targetVersion}`;
  if (current === next) {
    return false;
  }
  deps.openclaw = next;
  return true;
}

function syncPluginApiVersion(pkg: PackageJson, targetVersion: string): boolean {
  const compat = pkg.openclaw?.compat;
  const current = compat?.pluginApi;
  if (!current || !OPENCLAW_VERSION_RANGE_RE.test(current)) {
    return false;
  }
  const next = `>=${targetVersion}`;
  if (current === next) {
    return false;
  }
  compat.pluginApi = next;
  return true;
}

function syncBuildOpenClawVersion(pkg: PackageJson, targetVersion: string): boolean {
  const build = pkg.openclaw?.build;
  const current = build?.openclawVersion;
  if (!current) {
    return false;
  }
  if (current === targetVersion) {
    return false;
  }
  build.openclawVersion = targetVersion;
  return true;
}

function changelogVersionForPackageVersion(version: string): string {
  return version.replace(/-beta\.\d+$/u, "");
}

function ensureChangelogEntry(changelogPath: string, version: string, write: boolean): boolean {
  if (!existsSync(changelogPath)) {
    return false;
  }
  const content = readFileSync(changelogPath, "utf8");
  if (content.includes(`## ${version}`)) {
    return false;
  }
  const entry = `## ${version}\n\n### Changes\n- Version alignment with core OpenClaw release numbers.\n\n`;
  if (content.startsWith("# Changelog\n\n")) {
    const next = content.replace("# Changelog\n\n", `# Changelog\n\n${entry}`);
    if (write) {
      writeFileSync(changelogPath, next);
    }
    return true;
  }
  const next = `# Changelog\n\n${entry}${content.trimStart()}`;
  if (write) {
    writeFileSync(changelogPath, `${next}\n`);
  }
  return true;
}

export function syncPluginVersions(
  rootDir = resolve("."),
  options: SyncPluginVersionsOptions = {},
) {
  const write = options.write ?? true;
  const rootPackagePath = join(rootDir, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  // Plugin packages keep upstream's identifiers and are consumed by the OpenClaw
  // plugin ecosystem, so every version they carry -- the package version, the
  // `openclaw` dependency ranges, the `pluginApi` floor, and the build record --
  // stays in the upstream release domain rather than this fork's own semver. The
  // floor is also what `resolveCompatibilityHostVersion` is compared against, and
  // OPENCLAW_VERSION_RANGE_RE only recognises `>=YYYY.M.D`, so writing a `0.x`
  // target would both break compatibility checks and leave ranges this script can
  // no longer repair. `build.openclawVersion` rides along on purpose: the package
  // contract reports it as `builtWithOpenClawVersion` and defaults it to the
  // package version when absent, so a fork-domain value here would disagree with
  // the fallback for the very same package.
  // Keyed on the fork block itself, not on the nested `upstream`: a manifest that
  // declares `clawworks` but omits or nulls `upstream` would otherwise fall through
  // to the fork's own `0.x` and perform exactly the rewrite described above, which
  // no longer matches the range pattern this script repairs with. The root fallback
  // is reserved for a true upstream checkout, which carries no fork block at all.
  const forkMetadata = rootPackage.clawworks;
  const upstreamVersion = forkMetadata?.upstream?.version?.trim();
  if (forkMetadata && !UPSTREAM_VERSION_RE.test(upstreamVersion ?? "")) {
    throw new Error(
      "Root package.json declares clawworks but no valid clawworks.upstream.version.",
    );
  }
  const targetVersion = upstreamVersion ?? rootPackage.version;
  if (!targetVersion) {
    throw new Error("Root package.json missing version.");
  }

  const extensionsDir = join(rootDir, "extensions");
  const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const updated: string[] = [];
  const changelogged: string[] = [];
  const skipped: string[] = [];

  for (const dir of dirs) {
    const packagePath = join(extensionsDir, dir.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name) {
      skipped.push(dir.name);
      continue;
    }

    const changelogPath = join(extensionsDir, dir.name, "CHANGELOG.md");
    const changelogVersion = changelogVersionForPackageVersion(targetVersion);
    if (ensureChangelogEntry(changelogPath, changelogVersion, write)) {
      changelogged.push(pkg.name);
    }

    const versionChanged = pkg.version !== targetVersion;
    const devDependencyChanged = syncOpenClawDependencyRange(pkg.devDependencies, targetVersion);
    const peerDependencyChanged = syncOpenClawDependencyRange(pkg.peerDependencies, targetVersion);
    // minHostVersion is a compatibility floor, not release alignment metadata.
    // Keep it stable unless the owning plugin intentionally raises it.
    const pluginApiChanged = syncPluginApiVersion(pkg, targetVersion);
    const buildOpenClawVersionChanged = syncBuildOpenClawVersion(pkg, targetVersion);
    const packageChanged =
      versionChanged ||
      devDependencyChanged ||
      peerDependencyChanged ||
      pluginApiChanged ||
      buildOpenClawVersionChanged;
    if (!packageChanged) {
      skipped.push(pkg.name);
      continue;
    }

    if (versionChanged) {
      pkg.version = targetVersion;
    }
    if (write) {
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    updated.push(pkg.name);
  }

  return {
    targetVersion,
    updated,
    changelogged,
    skipped,
  };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const summary = syncPluginVersions(resolve("."), { write: !check });
  console.log(
    `Synced plugin versions to ${summary.targetVersion}. Updated: ${summary.updated.length}. Changelogged: ${summary.changelogged.length}. Skipped: ${summary.skipped.length}.`,
  );
  if (check && (summary.updated.length > 0 || summary.changelogged.length > 0)) {
    for (const packageName of summary.updated) {
      console.error(`  update required: ${packageName}`);
    }
    for (const packageName of summary.changelogged) {
      console.error(`  changelog entry required: ${packageName}`);
    }
    console.error("Run `pnpm plugins:sync` and commit the plugin version alignment.");
    process.exit(1);
  }
}
