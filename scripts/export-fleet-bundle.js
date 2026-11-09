import { readFile, writeFile } from "node:fs/promises";
import { createLibraryScenario } from "../public/scenario-library.js";
import { useTimelineOnly, validateProject } from "../public/model.js";
import { createFleetBundle } from "../public/fleet-bundle.js";

const [destination, source, ...extra] = process.argv.slice(2);
if (!destination || extra.length) {
  console.error("Usage: node scripts\\export-fleet-bundle.js <output.json> [project.json]");
  process.exitCode = 1;
} else {
  try {
    let project;
    if (source) project = validateProject(useTimelineOnly(JSON.parse(await readFile(source, "utf8"))));
    else {
      project = createLibraryScenario("daily-security");
      project.name = "Fleet handoff example";
      project.maps.push(createLibraryScenario("daily-cleaning").maps[0],
        createLibraryScenario("daily-delivery").maps[0]);
    }
    const bundle = createFleetBundle(project);
    await writeFile(destination, JSON.stringify(bundle, null, 2), { flag: "wx" });
    console.log(`Created ${destination}: ${bundle.scenarios.length} indexed scenarios; simulation only.`);
    const invalid = bundle.scenarios.filter(item => !item.executable).map(item => item.index);
    if (invalid.length) console.warn(`Non-executable indices retained with validation errors: ${invalid.join(", ")}`);
  } catch (error) {
    console.error(`Fleet bundle export failed: ${error.message}`);
    process.exitCode = 1;
  }
}
