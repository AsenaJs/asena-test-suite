import { scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { serviceConfig } from '../../src/services.ts';

export const parts = [scenario, waitFor, serviceConfig];
