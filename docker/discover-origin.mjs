import {discoverPortalOrigins} from '../src/deploymentOrigin.mjs';
process.stdout.write((await discoverPortalOrigins()).join(','));
