export const stageFor=action=>({describe:'scene',locate:'scene',remember:'save',history:'recall',check:'recall',appearance:'recall',find:'compare',identify:'compare'})[action]??null;
// Camera-use wording alone never identifies a phone as the memory target.
export const isRetake=raw=>/^(?:(?:好|好的|那|请|帮我|再|重新|用手机|手机|拿手机)[，,。\s]*)*(?:拍(?:一)?下|拍一张|拍个照|拍照|重新拍)(?:[，,。\s]*(?:(?:用)?手机)?(?:再)?拍(?:一)?下(?:这个|它)?|这个|它|吧|一下|[，,。！？!?\s])*$/u.test(raw.trim());
