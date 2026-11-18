import {readFileSync} from 'node:fs';
export const appearanceConfig=Object.freeze(JSON.parse(readFileSync(new URL('../appearance-config.json',import.meta.url),'utf8')));
if(!Number.isFinite(appearanceConfig.cropPaddingFraction)||appearanceConfig.cropPaddingFraction<0||appearanceConfig.cropPaddingFraction>.2)throw Error('appearance_padding_invalid');
