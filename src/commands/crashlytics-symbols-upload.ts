import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as spawn from "cross-spawn";
import * as uuid from "uuid";

import { Command } from "../command";
import { FirebaseError } from "../error";
import * as utils from "../utils";
import * as downloadUtils from "../downloadUtils";
import { util } from "chai";

enum SymbolGenerator {
  breakpad = "breakpad",
  csym = "csym",
}

interface Options {
  app: string|null;
  generator: SymbolGenerator|null;
  dryRun: boolean|null;
  debug: boolean|null;
  // Temporary override to use a local JAR until we get the fat jar in our
  // bucket
  localJar: string|null;
}

interface JarOptions {
  jarFile: string;
  app: string;
  generator: SymbolGenerator;
  cachePath: string;
  symbolFile: string;
  generate: boolean;
}

const SYMBOL_CACHE_ROOT_DIR = process.env.FIREBASE_CRASHLYTICS_CACHE_PATH || os.tmpdir();
const JAR_CACHE_DIR =
  process.env.FIREBASE_CRASHLYTICS_BUILDTOOLS_PATH || path.join(os.homedir(), ".cache", "firebase", "crashlytics", "buildtools");
const JAR_VERSION = "2.7.1";
const JAR_URL = `https://dl.google.com/android/maven2/com/google/firebase/firebase-crashlytics-buildtools/${JAR_VERSION}/firebase-crashlytics-buildtools-${JAR_VERSION}.jar`;

export default new Command("crashlytics:symbols:upload <symbol-files...>")
  .description("Upload symbols for native code, to symbolicate stack traces.")
  .option("--app <app_id>", "the app id of your Firebase app")
  .option(
    "--generator [breakpad|csym]",
    "the symbol generator being used, defaults to breakpad."
  )
  .option("--dry-run", "generate symbols without uploading them")
  .option("--debug", "print debug output and logging from the underlying uploader tool")
  .option("--local-jar <path>", "override the fetched jar with one on the filesystem")
  .action(async (symbolFiles: string[], options: Options) => {
    const app = getGoogleAppID(options) || "";
    const generator = getSymbolGenerator(options);
    const dryRun = !!options.dryRun;
    const debug = !!options.debug;

    let jarFile = await downloadBuiltoolsJar(debug);
    if (options.localJar) {
      jarFile = options.localJar;
    }

    const jarOptions: JarOptions = {
      jarFile,
      app,
      generator,
      cachePath: path.join(SYMBOL_CACHE_ROOT_DIR, `crashlytics-${uuid.v4()}`, "nativeSymbols", app, generator),
      symbolFile: "",
      generate: true,
    };

    for (const symbolFile of symbolFiles) {
      utils.logBullet(`Generating symbols for ${symbolFile}`);
      const generateArgs = buildArgs({ ...jarOptions, symbolFile });
      const output = runJar(generateArgs, debug);
      if (output.length > 0) {
        utils.logBullet(output);
      } else {
        utils.logBullet(`Generated symbols for ${symbolFile}`);
        utils.logBullet(`Output Path: ${jarOptions.cachePath}`);
      }
    }

    if (dryRun) {
      utils.logBullet("Skipping upload because --dry-run was passed");
      return;
    }

    utils.logBullet(`Uploading all generated symbols`);
    const uploadArgs = buildArgs({ ...jarOptions, generate: false });
    const output = runJar(uploadArgs, debug);
    if (output.length > 0) {
      utils.logBullet(output);
    } else {
      utils.logBullet("Successfully uploaded all symbols");
    }
  });

function getGoogleAppID(options: Options): string | null {
  if (!options.app) {
    throw new FirebaseError("set the --app option to a valid Firebase app id and try again");
  }
  return options.app;
}

function getSymbolGenerator(options: Options): SymbolGenerator {
  // Default to using BreakPad symbols
  if (!options.generator) {
    return SymbolGenerator.breakpad;
  }
  if (!Object.values(SymbolGenerator).includes(options.generator)) {
    throw new FirebaseError('--symbol-generator should be set to either "breakpad" or "csym"');
  }
  return options.generator;
}

async function downloadBuiltoolsJar(debug: boolean): Promise<string> {
  const jarPath = path.join(JAR_CACHE_DIR, `crashlytics-buildtools-${JAR_VERSION}.jar`);
  if (fs.existsSync(jarPath)) {
    if (debug) {
      utils.logBullet(`Buildtools Jar already downloaded at ${jarPath}`);
    }
    return jarPath;
  }
  // If the Jar cache directory exists, but the jar for the current version
  // doesn't, then we're running the CLI with a new Jar version and we can
  // delete the old version.
  if (fs.existsSync(JAR_CACHE_DIR)) {
    if (debug) {
      utils.logBullet(`Deleting Jar cache at ${JAR_CACHE_DIR} because the CLI was run with a newer Jar version`);
    }
    fs.rmdirSync(JAR_CACHE_DIR);
  }
  utils.logBullet("Downloading buildtools.jar to " + jarPath);
  const tmpfile = await downloadUtils.downloadToTmp(JAR_URL);
  fs.mkdirSync(JAR_CACHE_DIR, { recursive: true });
  fs.copySync(tmpfile, jarPath);
  return jarPath;
}

function buildArgs(options: JarOptions): string[] {
  const baseArgs = [
    "-jar",
    options.jarFile,
    `-symbolGenerator=${options.generator}`,
    `-symbolFileCacheDir=${options.cachePath}`,
    "-verbose",
  ];

  if (options.generate) {
    return baseArgs.concat(["-generateNativeSymbols", `-unstrippedLibrary=${options.symbolFile}`]);
  }

  return baseArgs.concat([
    "-uploadNativeSymbols",
    `-googleAppId=${options.app}`,
    // `-androidApplicationId=`,
  ]);
}

function runJar(args: string[], debug: boolean): string {
  // Inherit is better for debug output because it'll print as it goes. If we
  // pipe here and print after it'll wait until the command has finished to
  // print all the output.
  const outputs = spawn.sync("java", args, {
    stdio: debug ? "inherit" : "pipe",
  });

  if (outputs.status || 0 > 0) {
    if (!debug) {
      utils.logWarning(outputs.stdout?.toString() || "An unknown error occurred");
    }
    throw new FirebaseError("Failed to upload symbols");
  }

  // This is a bit gross, but since we don't have a great way to communicate
  // between the buildtools.jar and the CLI, we just pull the logs out of the
  // jar output.
  if (!debug) {
    var logRegex = /(Generated symbol file.*$)/m;
    var matched  = (outputs.stdout?.toString() || "").match(logRegex);
    if (matched) {
      return matched[1];
    }
    var logRegex = /(Crashlytics symbol file uploaded successfully.*$)/m;
    var matched  = (outputs.stdout?.toString() || "").match(logRegex);
    if (matched) {
      return matched[1];
    }
    return "";
  }
  return "";
}
