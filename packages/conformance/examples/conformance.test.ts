import { runConformance } from '@asenajs/adapter-conformance';
import { descriptor } from './adapter-descriptor';

// packageRoot: the directory the single-core guard resolves @asenajs/asena from - your adapter repo.
runConformance({ ...descriptor, packageRoot: import.meta.dir });
