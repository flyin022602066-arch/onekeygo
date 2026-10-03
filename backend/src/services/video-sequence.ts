// Restored from the last complete compiled implementation; keep runtime logic
// intact while this module is gradually re-annotated as TypeScript.
// @ts-nocheck
import { and, eq } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { db, schema } from '../db/index.js';
import { now } from '../utils/response.js';
import { downloadFile, getAbsolutePath } from '../utils/storage.js';
import { getConfigById } from './ai.js';
import { generateVideo } from './video-generation.js';
import { syncVolcCharacterAssetForCharacter, syncVolcImageAsset } from './volc-asset-sync.js';
import { logTaskError, logTaskProgress, logTaskWarn } from '../utils/task-logger.js';
import { withTkOverseasVisualLock } from './overseas-visual.js';
import { appendVideoDialoguePrompt, hasInjectedVideoDialogue, normalizeLocalVideoDialogue, normalizeVideoDialogue } from './video-dialogue-prompt.js';
import { hasLocalH3SpeechPlan, isLocalH3SpeechSnapshotCompatible } from './local-h3-speech.js';
import { bindLocalH3ActionSubjects, buildLocalH3CastPlan } from './local-h3-cast.js';
import { getFfmpegBinary } from './media-tools.js';
import { isCompletedVideoGeneration, isGenerationCurrentForStoryboard, pickLatestCompletedVideoGeneration, pickLatestVideoGeneration } from './storyboard-video-source.js';
import { assetBindingTerms, DEFAULT_ASSET_ALIASES, normalizeAssetText, parseAssetAliases } from './asset-aliases.js';
const execFileAsync = promisify(execFile);
const MAX_ASSETS = 9;
const LOCAL_LATENT_PLUS = 'latent_plus';
const STANDARD_R2V = 'standard_r2v';
// Local MiniMax H3 only accepts an ordered R2V image list.  The first item may
// carry continuity from the previous shot, but it is still an ordinary
// reference picture (never a provider first/last-frame input).
const CONTINUITY_REFERENCE_ROLE = 'continuity_reference';
function normalizeSequenceLoraStrength(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, Math.round(number * 100) / 100)) : 1;
}
function isContinuityReferenceRole(value) {
    const role = String(value || '').trim().toLowerCase();
    return role === CONTINUITY_REFERENCE_ROLE || role === 'first_frame';
}
// Local MiniMax H3 has no provider first/last-frame slot. Keep a separate
// predicate so remote legacy `first_frame` compatibility can never leak into
// the local R2V reference list.
function isLocalContinuityReferenceRole(value) {
    return String(value || '').trim().toLowerCase() === CONTINUITY_REFERENCE_ROLE;
}
function normalizeContinuityMode(value, provider) {
    const normalized = String(value || '').trim().toLowerCase();
    if (String(provider || '').trim().toLowerCase() === 'comfyui' && normalized === LOCAL_LATENT_PLUS)
        return LOCAL_LATENT_PLUS;
    return STANDARD_R2V;
}
/**
 * Resolve an ordinary continuity picture from a sequence step.  Local H3 has
 * two strict R2V contracts: standard mode stores the rendered continuity
 * picture in `continuityReference*`, while Motion Context Plus stores no
 * picture at all.  The `tailFrame*` fallback is retained only for remote
 * legacy providers.  Allowing it on a local step re-introduces the retired
 * tail/first-frame chain when an old run is resumed after re-decomposition.
 */
function continuityReferenceUrlFromStep(step, options = {}) {
    const allowLegacyTail = options.allowLegacyTail !== false;
    return step?.continuityReferenceLocalPath
        || step?.continuityReferenceUrl
        || step?.continuity_reference_local_path
        || step?.continuity_reference_url
        || (allowLegacyTail ? step?.tailFrameLocalPath : null)
        || (allowLegacyTail ? step?.tailFrameUrl : null)
        || (allowLegacyTail ? step?.tail_frame_local_path : null)
        || (allowLegacyTail ? step?.tail_frame_url : null)
        || null;
}
function latentDirectoryForRun(runId) {
    return `h3_context/mijing-studio-run-${Number(runId) || 0}`;
}
function latentSlotPath(runId, clipIndex) {
    const index = Math.max(1, Math.round(Number(clipIndex) || 1));
    return path.join('h3_context', `mijing-studio-run-${Number(runId) || 0}`, `clip_${String(index).padStart(5, '0')}.safetensors`);
}
function latentSlotRelativePath(latentPath, clipIndex) {
    const raw = String(latentPath || '').trim();
    if (!raw) return '';
    if (path.extname(raw).toLowerCase() === '.safetensors') return raw;
    const index = Math.max(1, Math.round(Number(clipIndex) || 1));
    return path.join(raw, `clip_${String(index).padStart(5, '0')}.safetensors`);
}
function latentSlotExistsForPath(latentPath, clipIndex, config = null) {
    const candidate = latentSlotRelativePath(latentPath, clipIndex);
    if (!candidate) return false;
    if (path.isAbsolute(candidate)) return fs.existsSync(candidate);
    const configuredOutput = String(config?.settings?.comfyui?.outputDir || '').trim();
    const environmentOutput = String(process.env.MIJING_COMFYUI_OUTPUT || process.env.COMFYUI_OUTPUT || '').trim();
    const roots = [
        configuredOutput,
        environmentOutput,
        'D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4\\output',
    ].filter(Boolean).filter((root, index, all) => all.indexOf(root) === index);
    return roots.some(root => fs.existsSync(path.resolve(root, candidate)));
}
function comfyOutputRoot(config = null) {
    const configured = String(config?.settings?.comfyui?.outputDir || '').trim();
    return configured || String(process.env.MIJING_COMFYUI_OUTPUT || process.env.COMFYUI_OUTPUT || '').trim() || 'D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4\\output';
}
function absoluteLatentSlotPath(latentPath, clipIndex, config = null) {
    const relative = latentSlotRelativePath(latentPath, clipIndex);
    if (!relative) return '';
    return path.isAbsolute(relative) ? relative : path.resolve(comfyOutputRoot(config), relative);
}
function copyLatentSlot(sourcePath, targetPath, clipIndex, config = null) {
    const source = absoluteLatentSlotPath(sourcePath, clipIndex, config);
    const target = absoluteLatentSlotPath(targetPath, clipIndex, config);
    if (!source || !fs.existsSync(source)) {
        throw new Error(`H3 Motion Context Plus 缺少前置 latent：clip_${String(clipIndex).padStart(5, '0')}.safetensors`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}
export function normalizeSequenceContinuityMode(value, provider) {
    return normalizeContinuityMode(value, provider);
}
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
const activeRuns = new Set();
/**
 * Storyboard extraction may describe an asset in English even though the
 * project asset pool uses the original Chinese name.  Keep this mapping
 * deterministic and local: it is only a bridge to an existing asset, never a
 * way to create a new one or to guess an unrelated object.
 */
function propBindingTerms(prop) {
    return assetBindingTerms(prop, DEFAULT_ASSET_ALIASES);
}
/**
 * A costume/wardrobe asset that is explicitly owned by a character must not
 * be uploaded as a second, independent H3 reference when that character's
 * portrait is already present.  R2V treats every picture as a visual identity
 * anchor; sending both a character sheet and (for example) that character's
 * white robe lets the robe image win and transfers the outfit to another
 * person.  Keep the costume ownership in text and let the character picture
 * remain the sole identity source.
 */
export function isCharacterOwnedProp(prop, character) {
    if (!prop || !character)
        return false;
    const propType = normalizeEntityText([prop.name, prop.type, prop.description, prop.prompt].filter(Boolean).join(' '));
    // Only suppress wardrobe/costume assets.  A named prop such as a sword or
    // basin remains a legitimate independent reference even when mentioned
    // alongside a character.
    if (!/(服饰|衣|袍|裙|法衣|外套|盔甲|铠甲|帽|冠|鞋|靴|robe|dress|costume|clothing|outfit|armor|armour|garment|衣物)/i.test(propType))
        return false;
    const characterTerms = characterBindingNames(character);
    return characterTerms.some(term => {
        const normalized = normalizeEntityText(term);
        return normalized && propType.includes(normalized);
    });
}

function characterOwnedPropNames(character, props = []) {
    return props
        .filter(prop => isCharacterOwnedProp(prop, character))
        .map(prop => String(prop.name || '').trim())
        .filter(Boolean);
}
export function filterCharacterOwnedWardrobeProps(props = [], characters = []) {
    const wardrobeKeys = new Set((props || [])
        .filter(prop => (characters || []).some(character => isCharacterOwnedProp(prop, character)))
        .map(prop => normalizeEntityText(prop.name))
        .filter(Boolean));
    return (props || []).filter(prop => !wardrobeKeys.has(normalizeEntityText(prop.name)));
}
function extractPromptVoiceNames(prompt) {
    const names = [];
    const pattern = /<voice>\s*([^<]+?)\s*<\/voice>/gi;
    let match;
    while ((match = pattern.exec(String(prompt || '')))) {
        const name = String(match[1] || '').trim();
        if (name && !names.includes(name))
            names.push(name);
    }
    return names;
}
function extractDialogueSpeakerNames(dialogue) {
    const names = [];
    for (const line of String(dialogue || '').split(/\r?\n/)) {
        const value = String(line || '').trim();
        const name = value.match(/^([^:：\n（）()]{1,40})\s*[:：]/)?.[1]?.trim()
            || value.match(/^([^:：\n（）()]{1,40})\s*[（(][^）)]{1,32}[）)]/)?.[1]?.trim()
            || '';
        if (name && !names.includes(name))
            names.push(name);
    }
    return names;
}
/** Build the immutable voice identity table used by local MiniMax H3 R2V.
 * Character rows are the single source of truth for voice id/provider; the
 * gender fallback is derived from the same persisted role/description fields
 * used by the storyboard extractor. */
function buildCharacterVoiceBindings(characters = [], sourceText = '') {
    return (Array.isArray(characters) ? characters : [])
        .filter(character => String(character?.name || '').trim())
        .map(character => {
            const voice = String(character.voiceStyle || character.voice_style || '').trim();
            const gender = inferSequenceCharacterGender(character, sourceText, voice);
            return {
                id: character.id,
                name: String(character.name).trim(),
                aliases: characterBindingNames(character).filter(alias => normalizeAssetText(alias) !== normalizeAssetText(character.name)),
                gender,
                // Persist the deterministic fallback in the binding itself.
                // This makes every serial shot carry the same concrete voice
                // id instead of relying on the provider to resolve it again.
                voiceStyle: voice || (gender === 'female' ? 'female-shaonv' : gender === 'male' ? 'male-qn-qingse' : 'neutral-fixed'),
                voiceProvider: character.voiceProvider || character.voice_provider || '',
            };
        });
}

/**
 * Resolve a character's voice gender from the same immutable facts used by
 * storyboard extraction.  Character rows often only say "主角"/"配角" and
 * therefore cannot identify gender by themselves; the nearby original
 * screenplay text is the deterministic tie-breaker.  Without this pass an
 * unconfigured female lead can be emitted as `unspecified`, allowing H3 to
 * choose a different voice on the next serial shot.
 */
export function inferSequenceCharacterGender(character, sourceText = '', voice = '') {
    const ownText = [character?.name, character?.role, character?.description, character?.appearance, character?.personality]
        .filter(Boolean).join(' ');
    if (/^female[-_]/i.test(voice) || /(女主|女配|女性|女声|少女|女生|女孩|夫人|小姐|姑娘|圣女|师姐|母亲|daughter|woman|girl|female)/i.test(ownText)) return 'female';
    if (/^male[-_]/i.test(voice) || /(男主|男性|男声|少年|男生|男孩|先生|长老|师父|店主|首领|son|man|boy|male)/i.test(ownText)) return 'male';
    // Group/role labels are stable facts and must win over pronouns in a
    // description that may refer to somebody else.
    if (/(弟子|追兵|食客|顾客|守卫)/i.test(String(character?.role || ''))) return 'male';

    const name = String(character?.name || '').trim();
    const source = String(sourceText || '');
    if (name && source) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const windows = [...source.matchAll(new RegExp(`.{0,140}${escaped}.{0,140}`, 'gi'))]
            .map(match => String(match[0] || ''));
        const femaleScore = windows.reduce((score, value) => score + (value.match(/她|姑娘|小姐|夫人|圣女|师姐|woman|girl|female|\\bshe\\b/gi) || []).length, 0);
        const maleScore = windows.reduce((score, value) => score + (value.match(/他(?!们)|先生|小伙|长老|师父|店主|首领|man|boy|male|\\bhe\\b/gi) || []).length, 0);
        if (femaleScore > maleScore && femaleScore > 0) return 'female';
        if (maleScore > femaleScore && maleScore > 0) return 'male';
    }
    return 'unspecified';
}
function countTermMentions(text, term) {
    const source = normalizeEntityText(text);
    const target = normalizeEntityText(term);
    if (!source || !target)
        return 0;
    let count = 0;
    let offset = source.indexOf(target);
    while (offset >= 0) {
        count++;
        offset = source.indexOf(target, offset + target.length);
    }
    return count;
}
function propMentionCount(text, prop, allProps = []) {
    const source = normalizeEntityText(text);
    if (!source)
        return 0;
    const terms = propBindingTerms(prop);
    const allTerms = allProps.flatMap(item => propBindingTerms(item));
    let count = 0;
    for (const term of terms) {
        let offset = source.indexOf(term);
        while (offset >= 0) {
            // Do not treat the generic word "beer" as a second prop when it is
            // only the prefix of the more specific "beer bottle" reference.
            const coveredBySpecificTerm = allTerms.some(other => (other !== term
                && other.length > term.length
                && other.includes(term)
                && source.slice(offset, offset + other.length) === other));
            if (!coveredBySpecificTerm)
                count++;
            offset = source.indexOf(term, offset + term.length);
        }
    }
    return count;
}
export function propMatchesStoryboardText(prop, storyboard, allProps = []) {
    const text = [storyboard.action, storyboard.dialogue, storyboard.videoPrompt, storyboard.result, storyboard.description, storyboard.imagePrompt]
        .map(stripVisualStyleLock)
        .filter(Boolean)
        .join('\n');
    return propMentionCount(text, prop, allProps) > 0;
}
function characterNameVariants(name) {
    return assetBindingTerms(typeof name === 'object' && name ? name : { name }, DEFAULT_ASSET_ALIASES);
}
function characterNamesMatch(left, right) {
    const leftVariants = characterNameVariants(left);
    const rightVariants = new Set(characterNameVariants(right));
    return leftVariants.some(value => rightVariants.has(value));
}
function characterNameAppears(text, name) {
    const source = normalizeEntityText(text);
    return characterNameVariants(name).some(variant => source.includes(variant));
}
function characterBindingNames(character) {
    const canonical = String(character.name || '').trim();
    const explicit = parseAssetAliases(character.aliases);
    const terms = assetBindingTerms(character, DEFAULT_ASSET_ALIASES);
    const values = [canonical, ...explicit, ...terms]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const key = normalizeAssetText(value);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        result.push(value);
        // Models often write a romanized name without the space used in the
        // asset alias ("Fengxi" vs "Feng Xi"). Keep that form explicit too.
        const compact = value.replace(/[\s\u3000]+/g, '');
        if (compact && normalizeAssetText(compact) !== key && !seen.has(normalizeAssetText(compact))) {
            seen.add(normalizeAssetText(compact));
            result.push(compact);
        }
    }
    return result;
}
function entityBindingNames(entity, canonicalName) {
    const canonical = String(canonicalName || entity?.name || entity?.location || '').trim();
    const explicit = parseAssetAliases(entity?.aliases);
    const terms = assetBindingTerms({
        name: canonical,
        aliases: entity?.aliases,
        englishName: entity?.englishName,
        english_name: entity?.english_name,
    }, DEFAULT_ASSET_ALIASES);
    const values = [canonical, ...explicit, ...terms]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const seen = new Set();
    return values.filter(value => {
        const key = normalizeAssetText(value);
        if (!key || seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function characterBindingLabel(item) {
    const name = String(item.entityName || '').trim();
    const aliases = (item.aliases || []).filter(alias => normalizeAssetText(alias) !== normalizeAssetText(name));
    return aliases.length ? `${name} (${aliases.join(', ')})` : name;
}
function referenceBindingLabel(item, fallback) {
    if (item.role !== 'character')
        return fallback;
    return characterBindingLabel(item);
}
function stripVisualStyleLock(value) {
    return String(value || '').split(/视觉风格锁定|visual style lock/i, 1)[0];
}
/** Deterministic serial order: previous tail, scene, characters/props, then
 * optional manual references. Required continuity and scene assets cannot be
 * displaced by optional images. */
export function orderSerialReferenceAssets(refs) {
    const hasPrimaryCharacter = refs.some(ref => ref.primary && String(ref.role || '').trim().toLowerCase() === 'character');
    const hasOpeningFrame = refs.some(ref => isContinuityReferenceRole(ref.role));
    const priority = hasPrimaryCharacter
        ? { continuity_reference: 0, first_frame: 0, scene: 2, character: 3, prop: 4, reference_image: 5 }
        : { continuity_reference: 0, first_frame: 0, scene: 1, character: 2, prop: 3, reference_image: 4 };
    return refs
        .map((ref, index) => ({
        ref,
        index,
        // Keep the lead character immediately after the continuity frame. This
        // gives the locally uploaded protagonist image a deterministic semantic
        // slot before the scene and supporting cast can dilute its identity.
        rank: ref.primary && String(ref.role || '').trim().toLowerCase() === 'character'
            ? (hasOpeningFrame ? 1 : 0)
            : priority[isContinuityReferenceRole(ref.role) ? String(ref.role || '').trim().toLowerCase() : String(ref.role || '')] ?? 6,
    }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(item => item.ref);
}
/** Split a serial R2V reference list into its semantic opening frame and the
 * references that may influence the motion after frame 0.  The local H3
 * Director has no first_frame input on the R2V group, so the opening image is
 * still sent as Picture 1, but keeping it out of the secondary list avoids a
 * duplicate upload/ambiguous index that can make the scene or a character
 * replace the continuity frame.
 */
export function splitSerialReferenceImages(refs, maxImages = MAX_ASSETS) {
    const ordered = orderSerialReferenceAssets(refs);
    // There must be one semantic opening image at most.  A stale retry can
    // contain the same tail more than once (or contain multiple first_frame
    // entries); keeping any of those in the secondary list lets H3 treat it as
    // a normal reference and can overwrite the opening composition.
    const continuityReference = ordered.find(item => isContinuityReferenceRole(item.role)) || null;
    const firstKey = continuityReference ? referenceSourceKey(continuityReference.url) : '';
    const seen = new Set();
    const secondary = ordered.filter(item => {
        const role = String(item.role || '').trim().toLowerCase();
        if (isContinuityReferenceRole(role))
            return false;
        const key = referenceSourceKey(item.url);
        if (key && (key === firstKey || seen.has(key)))
            return false;
        if (key)
            seen.add(key);
        return true;
    });
    const limit = Math.max(0, Number(maxImages) || MAX_ASSETS) - (continuityReference ? 1 : 0);
    return {
        firstFrameUrl: continuityReference?.url || null,
        referenceImages: secondary.slice(0, limit),
    };
}
/** Canonicalise local static paths so `/static/foo.png`, `static/foo.png`
 * and a localhost URL pointing at the same file do not consume separate
 * ComfyUI reference slots.  Remote URLs keep their query string because it
 * may identify a genuinely different object. */
function referenceSourceKey(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return '';
    const staticPath = raw.replace(/^https?:\/\/[^/]+\/static\//i, 'static/')
        .replace(/^\/static\//i, 'static/');
    if (staticPath.startsWith('static/'))
        return `static:${staticPath.slice('static/'.length)}`;
    return raw.replace(/\\/g, '/');
}
export function validateSerialReferenceSlots(refs, options = {}) {
    const maxImages = Math.max(1, Number(options.maxImages) || MAX_ASSETS);
    if (refs.length > maxImages) {
        throw new Error(`镜头${options.storyboardNumber || ''}需要 ${refs.length} 张串行参考图，超过最多 ${maxImages} 张限制`);
    }
    if (options.localR2v && refs.some(item => ['first_frame', 'last_frame'].includes(String(item?.role || '').trim().toLowerCase()))) {
        throw new Error(`镜头${options.storyboardNumber || ''}本地 MiniMax H3 多参考链路禁止首帧/尾帧资产角色`);
    }
    if (options.localR2v && refs.some(item => String(item?.role || '').trim().toLowerCase() === CONTINUITY_REFERENCE_ROLE)) {
        throw new Error(`镜头${options.storyboardNumber || ''}本地 MiniMax H3 使用完整 Video 1 连续，禁止连续参考图占用 Picture 图片位`);
    }
    const rolePredicate = options.localR2v ? isLocalContinuityReferenceRole : isContinuityReferenceRole;
    const firstFrameIndexes = refs
        .map((item, index) => rolePredicate(item.role) ? index : -1)
        .filter(index => index >= 0);
    if (firstFrameIndexes.length > 1) {
        throw new Error(`镜头${options.storyboardNumber || ''}存在多个首帧参考图；上一镜尾帧只能占用 Picture 1`);
    }
    const seenSources = new Set();
    for (const [index, item] of refs.entries()) {
        const source = referenceSourceKey(item.url);
        if (!source)
            continue;
        if (seenSources.has(source)) {
            throw new Error(`镜头${options.storyboardNumber || ''}存在重复参考图（Picture ${index + 1}）；重复图片不得占用参考槽位`);
        }
        seenSources.add(source);
    }
    if (options.hasFirstFrame && firstFrameIndexes[0] !== 0) {
        throw new Error(`镜头${options.storyboardNumber || ''}的上一镜尾帧必须排在 Picture 1`);
    }
    return true;
}
/** Resolve the continuity frame from the immediately preceding step. */
export function resolveSequenceStepFirstFrameLocalPath(step, previous) {
    // Local H3 has no provider first-frame input.  This compatibility helper
    // resolves only the neutral continuity picture used as ordered Picture 1;
    // legacy first/tail-frame columns are deliberately ignored.
    return continuityReferenceUrlFromStep(previous, { allowLegacyTail: false })
        || continuityReferenceUrlFromStep(step, { allowLegacyTail: false })
        || null;
}
/** Local H3 serial jobs always use the dedicated R2V group/checkpoint. The
 * complete previous video is Video 1; Picture slots are reserved for current
 * scene/character/prop references and never routed through FL2VA/I2V. */
export function resolveComfyUiSerialReferenceMode(hasFirstFrame) {
    // H3 R2V has no first-frame/last-frame fields. Video 1 is passed through
    // the dedicated video reference input and never converted into a Picture.
    return 'multiple';
}

/**
 * Local MiniMax H3 never has a provider frame slot.  Keep this assertion at
 * the sequence boundary as a final guard against stale callers writing a
 * legacy mode into a newly-created local run.
 */
export function assertLocalSequenceR2VContract(provider, continuityMode, refs = []) {
    if (!['comfyui', 'autodl_comfyui'].includes(String(provider || '').trim().toLowerCase())) return true;
    const rawMode = String(continuityMode || '').trim().toLowerCase();
    const mode = rawMode || STANDARD_R2V;
    if (!['standard_r2v', LOCAL_LATENT_PLUS].includes(mode))
        throw new Error('本地 MiniMax H3 仅支持标准 R2V 或 Motion Context Plus');
    if (!Array.isArray(refs) || refs.length === 0)
        throw new Error('本地 MiniMax H3 R2V 必须提供有序多参考图片');
    if (refs.some(item => ['first_frame', 'last_frame'].includes(String(item?.role || '').trim().toLowerCase())))
        throw new Error('本地 MiniMax H3 多参考链路禁止首帧/尾帧资产角色');
    if (refs.some(item => String(item?.role || '').trim().toLowerCase() === CONTINUITY_REFERENCE_ROLE))
        throw new Error('本地 MiniMax H3 连续性由完整 Video 1 或 AV latent 提供，禁止把连续参考图占用 Picture 图片位');
    return true;
}
export function assertLocalSequenceContinuityMode(provider, continuityMode) {
    if (!['comfyui', 'autodl_comfyui'].includes(String(provider || '').trim().toLowerCase())) return true;
    const value = String(continuityMode || '').trim().toLowerCase();
    if (value && ![STANDARD_R2V, LOCAL_LATENT_PLUS].includes(value))
        throw new Error('本地 MiniMax H3 仅支持标准 R2V 或 Motion Context Plus');
    return true;
}
/**
 * Storyboard prompts describe a desired composition at 0 seconds. For a
 * follow-up serial shot that description is often different from the actual
 * previous tail (for example it can place a later speaker in frame already),
 * which directly contradicts the continuity reference. Replace only that
 * generated opening-state clause and delay the first 0-second action until
 * after the deterministic hand-off. The script, dialogue and later timing are
 * otherwise preserved verbatim.
 */
export function lockComfyUiSerialOpeningState(original, hasFirstFrame) {
    const source = String(original || '').trim();
    if (!hasFirstFrame || !source)
        return source;
    const openingState = /0\s*\u79d2\s*\u9996\u5e27\u72b6\u6001\s*[\uFF1A:]\s*[^\uFF1B;\r\n]*(?:[\uFF1B;]\s*)?/i;
    let remainder = source.replace(openingState, '').trim();
    const firstZeroInterval = /(^|[\uFF1B;\r\n]\s*)0(?:\.0+)?\s*\u81f3\s*(\d+(?:\.\d+)?\s*\u79d2)/;
    remainder = remainder.replace(firstZeroInterval, (_match, prefix, end) => `${prefix}0.25\u81f3${end}`);
    const lockedOpening = [
        '0\u79d2\u9996\u5e27\u72b6\u6001\uFF1A\u4e25\u683c\u590d\u5236<Picture 1>\uFF0c\u4e0d\u4f7f\u7528\u540e\u7eed\u5267\u60c5\u6587\u5b57\u91cd\u6784\u9996\u5e27\uFF1B',
        `0\u81f30.25\u79d2\uFF1A\u4fdd\u6301<Picture 1>\u7684\u4eba\u7269\u6570\u91cf\u3001\u7ad9\u4f4d\u3001\u59ff\u52bf\u3001\u9053\u5177\u3001\u673a\u4f4d\u3001\u666f\u522b\u3001\u5149\u7ebf\u548c\u80cc\u666f\u5b8c\u5168\u4e0d\u53d8\uFF0c\u9996\u5e27\u672a\u51fa\u73b0\u7684\u4eba\u7269\u6216\u9053\u5177\u4e0d\u5f97\u63d0\u524d\u5165\u955c\uFF1B`,
    ].join('');
    return `${lockedOpening}${remainder}`;
}
export function buildVideoSequenceReusePlan(input) {
    const completedByStoryboard = new Map();
    const preservePrefixUntilIndex = Number.isInteger(input.preservePrefixUntilIndex)
        && Number(input.preservePrefixUntilIndex) >= 0
        ? Number(input.preservePrefixUntilIndex)
        : null;
    const completedPrefixByStoryboard = new Map();
    for (const storyboard of input.storyboards) {
        const historyCandidates = input.historicalSteps
            .filter(step => Number(step.storyboardId) === Number(storyboard.id))
            // Ignore the new run's pending row when reconciling. A previous
            // preparation failure must remain visible until that shot succeeds.
            .filter(step => ['failed', 'completed', 'skipped'].includes(String(step.status || '').toLowerCase()))
            .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        const latestHistory = historyCandidates[0] || null;
        completedByStoryboard.set(storyboard.id, pickLatestReusableGeneration(input.videoGenerations, storyboard.id, latestHistory, {
            provider: input.provider,
            continuityMode: input.continuityMode,
            model: input.model,
            storyboard,
        }));
        if (preservePrefixUntilIndex != null) {
            const completedHistory = historyCandidates.find(step => ['completed', 'skipped'].includes(String(step.status || '').toLowerCase()) && step.videoGenerationId);
            const completedGeneration = input.videoGenerations
                .filter(generation => Number(generation.storyboardId) === Number(storyboard.id) && isCompletedVideoGeneration(generation))
                .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null;
            const historyGeneration = completedHistory?.videoGenerationId
                ? input.videoGenerations.find(generation => Number(generation.id) === Number(completedHistory.videoGenerationId) && isCompletedVideoGeneration(generation))
                : null;
            completedPrefixByStoryboard.set(storyboard.id, historyGeneration || completedGeneration);
        }
    }
    // A serial run is one continuous chain.  Once a shot cannot be safely
    // reused (missing output, failed preparation, stale character bindings,
    // or a mode/decomposition mismatch), every later shot depends on its
    // newly rendered continuity image/latent and must be regenerated too.
    // The old plan evaluated each shot independently, so a stale shot 1 could
    // be regenerated while shot 2+ silently reused generations built from the
    // old character mapping.  Keep an explicit boundary for the first
    // non-reusable shot.  Motion Context Plus may override that boundary only
    // for an explicit later-shot resume; the selected shot still validates its
    // immediate predecessor's latent before submission.
    const firstNonReusableIndex = input.storyboards.findIndex(storyboard => !completedByStoryboard.get(storyboard.id)?.id);
    const requestedBoundary = Number.isInteger(input.forceFromIndex) && Number(input.forceFromIndex) >= 0
        ? Number(input.forceFromIndex)
        : null;
    const boundaries = [firstNonReusableIndex >= 0 ? firstNonReusableIndex : null, requestedBoundary]
        .filter(index => index != null)
        .map(index => Number(index));
    const chainBoundary = preservePrefixUntilIndex != null
        ? preservePrefixUntilIndex
        : (boundaries.length ? Math.min(...boundaries) : null);
    return input.storyboards.map((storyboard, index) => {
        if (chainBoundary != null && index >= chainBoundary) {
            return {
                storyboardId: storyboard.id,
                status: 'pending',
                videoGenerationId: null,
                reused: false,
                needsTailPreparation: false,
                historyStep: null,
            };
        }
        const preservePrefix = preservePrefixUntilIndex != null && index < preservePrefixUntilIndex;
        const generation = completedByStoryboard.get(storyboard.id)
            || (preservePrefix ? completedPrefixByStoryboard.get(storyboard.id) : null)
            || null;
        if (!generation?.id) {
            if (preservePrefix) {
                return {
                    storyboardId: storyboard.id,
                    status: 'skipped',
                    videoGenerationId: null,
                    reused: false,
                    needsTailPreparation: false,
                    historyStep: null,
                };
            }
            return {
                storyboardId: storyboard.id,
                status: 'pending',
                videoGenerationId: null,
                reused: false,
                needsTailPreparation: false,
                historyStep: null,
            };
        }
        const matchingHistory = input.historicalSteps
            .filter(step => Number(step.storyboardId) === storyboard.id && Number(step.videoGenerationId || 0) === Number(generation.id))
            .sort((a, b) => historyStepReuseScore(b, input.provider) - historyStepReuseScore(a, input.provider));
        const historyStep = matchingHistory[0] || null;
        if (preservePrefix) {
            return {
                storyboardId: storyboard.id,
                status: 'skipped',
                videoGenerationId: Number(generation.id),
                reused: true,
                needsTailPreparation: false,
                historyStep,
            };
        }
        const nextStoryboard = input.storyboards[index + 1];
        const nextNeedsGeneration = !!nextStoryboard
            && (!completedByStoryboard.get(nextStoryboard.id)
                || (chainBoundary != null && index + 1 >= chainBoundary));
    // Standard R2V hands the previous shot's rendered continuity image to the
    // next shot. H3 Motion Context Plus has a different contract: the
        // previous shot's AV latent is the continuity source, so preparing a
        // PNG tail would mix the two modes and needlessly enter
    // latent carries continuity and no image preparation is needed.
        const needsTailPreparation = nextNeedsGeneration
            && !hasReusableContinuity(historyStep, input.provider, input.continuityMode, input.config);
        return {
            storyboardId: storyboard.id,
            status: needsTailPreparation ? 'pending' : 'skipped',
            videoGenerationId: Number(generation.id),
            reused: true,
            needsTailPreparation,
            historyStep,
        };
    });
}
function hasReusableContinuity(step, provider, continuityMode, config = null) {
    if (normalizeContinuityMode(continuityMode, provider) === LOCAL_LATENT_PLUS) {
        const latentPath = step?.latentPath;
        const clipIndex = Number(step?.latentClipIndex || 0);
        return !!latentPath && Number.isFinite(clipIndex) && clipIndex > 0
            && latentSlotExistsForPath(latentPath, clipIndex, config);
    }
    // A local H3 standard run may only reuse the new neutral continuity
    // reference fields.  Never promote a legacy `tailFrame*` value into
    // Picture 1: that row belongs to the retired FL2VA/I2V chain and must be
    // regenerated with a clean R2V snapshot.
    if (String(provider || '').trim().toLowerCase() === 'comfyui') {
        return hasReusableTailFrame(step, provider);
    }
    return hasReusableContinuityReference(step, provider);
}
/** A serial shot can only be reused when its continuity tail is available.
 * A completed generation without a prepared tail must be regenerated (or
 * have its tail prepared) before the next shot is submitted. */
function hasReusableTailFrameForSequence(step, provider) {
    return hasReusableContinuityReference(step, provider);
}
/**
 * A newer failed/processing generation must invalidate an older completed
 * video. Otherwise starting a new serial run after a failure silently skips
 * the failed shot by reusing stale output from an earlier attempt.
 */
function pickLatestReusableGeneration(generations, storyboardId, latestHistory = null, options = {}) {
    const latest = pickLatestVideoGeneration(generations, storyboardId);
    // A failed sequence step is authoritative even when no generation row was
    // created (for example, reference preparation can fail before submission).
    // Never let an older completed generation hide that failure on the next run.
    if (String(latestHistory?.status || '').toLowerCase() === 'failed') {
        const failedGenerationId = Number(latestHistory?.videoGenerationId || 0);
        if (!latest || !failedGenerationId || Number(latest.id || 0) <= failedGenerationId)
            return null;
    }
    // A re-decomposition can leave an older completed local generation row in
    // place even though its prompt/reference list was built from the previous
    // character whitelist.  Never reuse that row: doing so makes the first
    // shot appear to ignore the new R2V mode and can reintroduce a character
    // that the current storyboard explicitly hides.  The newest generation
    // remains authoritative; if it is incompatible, regenerate instead of
    // falling back to an even older (also stale) generation.
    if (latest && options?.storyboard && !isGenerationCompatibleWithStoryboard(latest, options.storyboard, options.provider, options.continuityMode)) {
        return null;
    }
    if (latest && String(options?.provider || '').trim().toLowerCase() === 'comfyui'
        && String(options?.model || '').trim()
        && String(latest.model || '').trim() !== String(options.model).trim()) {
        return null;
    }
    return latest && isCompletedVideoGeneration(latest) ? latest : null;
}

/**
 * Validate a completed generation before it enters a new serial reuse plan.
 * This is intentionally a conservative check for local H3 only.  Provider
 * parameters must remain ordinary multi-reference R2V, and the persisted
 * binding section must contain exactly the current shot's active character
 * whitelist.  A generation whose binding section still contains a
 * background-only/removed character is stale and must be regenerated.
 */
export function isGenerationCompatibleWithStoryboard(generation, storyboard, provider, continuityMode) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!['comfyui', 'autodl_comfyui'].includes(normalizedProvider)) return true;
    const mode = String(generation?.referenceMode || generation?.reference_mode || '').trim().toLowerCase();
    const generationContinuityRaw = String(generation?.continuityMode || generation?.continuity_mode || '').trim().toLowerCase();
    if (normalizedProvider === 'autodl_comfyui') {
        if (mode !== 'multiple' || generationContinuityRaw !== STANDARD_R2V) return false;
        if (String(generation?.imageUrl || generation?.image_url || '').trim()
            || String(generation?.firstFrameUrl || generation?.first_frame_url || '').trim()
            || String(generation?.lastFrameUrl || generation?.last_frame_url || '').trim()) return false;
        if (!storyboard?.episodeId) return true;
        const context = getStoryboardContext(storyboard);
        const prompt = String(generation?.finalPrompt || generation?.final_prompt || generation?.prompt || '').trim();
        if (!prompt || !isStoryboardDialogueSnapshotCompatible(prompt, storyboard)) return false;
        const bindingSection = prompt.split(/\r?\n/).find(line => /^AutoDL ComfyUI .*Picture/i.test(line)) || '';
        const hasName = (name) => {
            const terms = characterBindingNames({ name });
            return terms.some(term => bindingSection.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()));
        };
        if (context.characters.some(character => !hasName(character.name))) return false;
        const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all();
        const dramaId = episode?.dramaId;
        if (!dramaId) return true;
        const allCharacters = db.select().from(schema.characters).all()
            .filter(character => !character.deletedAt && character.dramaId === dramaId);
        const currentIds = new Set(context.characters.map(character => Number(character.id)));
        if (allCharacters.some(character => !currentIds.has(Number(character.id)) && hasName(character.name))) return false;
        return persistedBindingIdsMatchContext(prompt, context);
    }
    // Inspect the persisted prompt before the metadata fast-path.  A legacy
    // local row can lack reference_mode/continuity_mode entirely while still
    // carrying first/last/tail-frame instructions; allowing that row to be
    // reused would silently revive the retired FL2VA/I2V workflow.
    const persistedPrompt = String(generation?.finalPrompt || generation?.final_prompt || generation?.prompt || '');
    if (hasLegacyLocalH3FrameSemantics(persistedPrompt)) return false;
    // Rows created by very old callers may only contain a local video path and
    // no provider metadata.  They remain reusable only when their prompt is
    // already free of the retired frame contract (checked above).
    // A local H3 generation must carry explicit metadata from the current
    // R2V pipeline. Rows without it are ambiguous legacy snapshots and are
    // never safe to reuse after a re-decomposition. Do not count legacy
    // frame/image fields as metadata: those fields are precisely what this
    // guard is meant to reject.
    if (!mode || !generationContinuityRaw) return false;
    if (mode !== 'multiple') return false;
    // Local MiniMax H3 has no single-image or provider frame slots. Any old
    // image_url/first_frame_url/last_frame_url value makes the snapshot
    // incompatible even when reference_mode was later rewritten to multiple.
    if (String(generation?.imageUrl || generation?.image_url || '').trim()
        || String(generation?.firstFrameUrl || generation?.first_frame_url || '').trim()
        || String(generation?.lastFrameUrl || generation?.last_frame_url || '').trim()) return false;
    if (![STANDARD_R2V, LOCAL_LATENT_PLUS].includes(generationContinuityRaw)) return false;
    const generationContinuity = normalizeContinuityMode(generationContinuityRaw, provider);
    const requestedContinuity = normalizeContinuityMode(continuityMode, provider);
    if (generationContinuity !== requestedContinuity) return false;
    // A generated row is an immutable snapshot.  Re-decomposing a storyboard
    // updates its timestamp; any older local H3 row must therefore be treated
    // as stale even if its mode metadata still says `multiple`.
    const storyboardUpdatedAt = Date.parse(String(storyboard?.updatedAt || storyboard?.updated_at || ''));
    // Generation updated_at is mutated by provider polling and local media
    // download.  It is not a storyboard revision marker; use creation time
    // only when deciding whether a snapshot predates the current decomposition.
    const generationUpdatedAt = Date.parse(String(generation?.createdAt || generation?.created_at || ''));
    if (normalizedProvider === 'comfyui'
        && Number.isFinite(storyboardUpdatedAt) && Number.isFinite(generationUpdatedAt)
        && generationUpdatedAt < storyboardUpdatedAt)
        return false;
    if (!storyboard?.episodeId) return true;
    const context = getStoryboardContext(storyboard);
    const reusableProps = filterCharacterOwnedWardrobeProps(context.props, context.characters);
    const reusableContext = reusableProps.length === context.props.length
        ? context
        : { ...context, props: reusableProps };
    const prompt = String(generation?.finalPrompt || generation?.final_prompt || generation?.prompt || '').trim();
    if (!prompt) return false;
    // Dialogue is part of the immutable storyboard snapshot.  A generation
    // built before a line/speaker change must never be reused merely because
    // the current character whitelist still happens to match.
    if (!isStoryboardDialogueSnapshotCompatible(prompt, storyboard, true)) return false;
    const bindingSection = prompt.split(/PICTURE-TO-ASSET BINDINGS/i, 1)[0];
    const hasName = (name) => {
        const terms = characterBindingNames({ name });
        return terms.some(term => bindingSection.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()));
    };
    // Every current active character must have its own persisted Picture
    // binding.  This catches partial/old prompts even when the video itself
    // is marked completed.
    if (context.characters.some(character => !hasName(character.name))) return false;
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all();
    const dramaId = episode?.dramaId;
    if (!dramaId) return true;
    const allCharacters = db.select().from(schema.characters).all()
        .filter(character => !character.deletedAt && character.dramaId === dramaId);
    const currentIds = new Set(context.characters.map(character => Number(character.id)));
    // A completed row is reusable only when its persisted Picture bindings are
    // exactly the current shot's character whitelist.  Checking only
    // `background-only` text is insufficient: a re-decomposition can turn a
    // previously visible role into a removed role (or change the wording),
    // while the old prompt still carries that portrait.  Such a row is the
    // source of the classic “主角被另一角色替换” regression, so force a fresh
    // request whenever any known project character appears in the old binding
    // section but is absent from this shot's resolved context.
    const staleBoundCharacter = allCharacters.find(character => {
        if (currentIds.has(Number(character.id)))
            return false;
        return hasName(character.name);
    });
    if (staleBoundCharacter)
        return false;
    const shotText = [storyboard.title, storyboard.location, storyboard.time, storyboard.videoPrompt,
        storyboard.action, storyboard.description, storyboard.result, storyboard.imagePrompt,
        storyboard.atmosphere, storyboard.dialogue].filter(Boolean).join('\n');
    // A background-only/removed identity in the old binding section is a hard
    // incompatibility.  We deliberately do not reject other non-visible
    // names that are merely present in prose: only a stale Picture mapping is
    // unsafe for R2V identity assignment.
    const staleBackgroundCharacter = allCharacters.find(character => !currentIds.has(Number(character.id))
        && isCharacterBackgroundOnlyMention(shotText, character)
        && hasName(character.name));
    if (staleBackgroundCharacter) return false;
    // New local snapshots carry stable entity IDs beside each Picture.  When
    // present, compare the exact character set instead of relying solely on
    // display-name substring checks (which can conflate aliases such as
    // “弟子甲” and “甲弟子”). Legacy prompts without IDs keep the name-based
    // checks above for backwards compatibility but remain subject to the
    // prompt/dialogue snapshot guard.
    return persistedBindingIdsMatchContext(prompt, reusableContext);
}

/**
 * Compare the stable entity IDs embedded in a generated prompt with the
 * current storyboard context.  This is deliberately pure so it can be
 * regression-tested without touching the user's production database.
 * Prompts written before entity IDs were introduced remain compatible here;
 * once a role has IDs, however, its set must match the current shot exactly.
 */
export function persistedBindingIdsMatchContext(prompt, context) {
    const bindingIdsByRole = new Map();
    for (const match of String(prompt || '').matchAll(/binding_role\s*=\s*(character|scene|prop)\s*;\s*entity_id\s*=\s*(\d+)/gi)) {
        const role = String(match[1] || '').trim().toLowerCase();
        const id = Number(match[2]);
        if (!Number.isFinite(id) || id <= 0) continue;
        const ids = bindingIdsByRole.get(role) || new Set();
        ids.add(id);
        bindingIdsByRole.set(role, ids);
    }
    const expectedIds = (items) => [...new Set((Array.isArray(items) ? items : [])
        .map(item => Number(item?.id))
        .filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
    const sameIds = (actual, expected) => actual.length === expected.length
        && actual.every((id, index) => id === expected[index]);
    const bindingCharacterIds = [...(bindingIdsByRole.get('character') || [])].sort((a, b) => a - b);
    if (bindingCharacterIds.length && !sameIds(bindingCharacterIds, expectedIds(context?.characters))) return false;
    const bindingSceneIds = [...(bindingIdsByRole.get('scene') || [])].sort((a, b) => a - b);
    if (bindingSceneIds.length && !sameIds(bindingSceneIds, expectedIds(context?.scene ? [context.scene] : []))) return false;
    const bindingPropIds = [...(bindingIdsByRole.get('prop') || [])].sort((a, b) => a - b);
    if (bindingPropIds.length && !sameIds(bindingPropIds, expectedIds(context?.props))) return false;
    return true;
}

export function assertLocalH3CharacterReferenceBindings(refs, context, storyboardNumber = '') {
    const expectedIds = [...new Set((context?.characters || [])
        .map(item => Number(item?.id))
        .filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
    const characterRefs = (Array.isArray(refs) ? refs : [])
        .filter(item => String(item?.role || '').trim().toLowerCase() === 'character');
    const actualIds = characterRefs
        .map(item => Number(item?.entityId || 0))
        .filter(id => Number.isFinite(id) && id > 0)
        .sort((a, b) => a - b);
    const hasUnboundCharacter = characterRefs.some(item => !Number.isFinite(Number(item?.entityId)) || Number(item?.entityId) <= 0);
    const sameIds = expectedIds.length === actualIds.length
        && expectedIds.every((id, index) => id === actualIds[index]);
    if (hasUnboundCharacter || !sameIds) {
        const expectedNames = (context?.characters || []).map(item => String(item?.name || '').trim()).filter(Boolean);
        const actualNames = characterRefs.map(item => String(item?.entityName || item?.name || '').replace(/^角色-/, '').trim()).filter(Boolean);
        const label = storyboardNumber ? `镜头${storyboardNumber}` : '当前镜头';
        throw new Error(`${label}本地 MiniMax H3 角色参考绑定已过期：当前应为【${expectedNames.join('、') || '无'}】，实际提交为【${actualNames.join('、') || '无'}】；已阻止提交，请刷新当前分镜绑定后重试`);
    }
    return true;
}

/**
 * Validate the dialogue portion of a persisted local-H3 prompt against the
 * current storyboard.  We intentionally compare the exact spoken text after
 * removing the speaker prefix/formatting, while also requiring the named
 * speaker to remain present. This catches a stale generation whose line was
 * reassigned to another role during re-decomposition.
 */
export function isStoryboardDialogueSnapshotCompatible(prompt, storyboard, localComfyUi = false) {
    const value = String(prompt || '');
    const normalized = localComfyUi
        ? normalizeLocalVideoDialogue(String(storyboard?.dialogue || ''), null)
        : normalizeVideoDialogue(String(storyboard?.dialogue || ''), null);
    if (localComfyUi && hasLocalH3SpeechPlan(value)) return isLocalH3SpeechSnapshotCompatible(value, normalized);
    if (!normalized) return !hasInjectedVideoDialogue(value);
    const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const expectedSpeakers = [...new Set(lines.map(extractDialogueSpeakerSnapshot).filter(Boolean))];
    const persistedVoiceNames = [...value.matchAll(/<voice>\s*([^<]+?)\s*<\/voice>/gi)]
        .map(match => String(match[1] || '').trim())
        .filter(Boolean);
    // A prompt may still contain the spoken line text with the correct
    // speaker prefix while its <voice> tag points at another character. Treat
    // the explicit voice tags as authoritative and reject that mismatch.
    if (persistedVoiceNames.length && expectedSpeakers.length) {
        const expected = new Set(expectedSpeakers.map(item => normalizeEntityText(item)));
        const actual = new Set(persistedVoiceNames.map(item => normalizeEntityText(item)));
        if (expected.size !== actual.size || [...expected].some(item => !actual.has(item))) return false;
    }
    for (const line of lines) {
        const spoken = compactDialogueSnapshot(stripDialogueSpeakerSnapshot(line));
        if (!spoken || countCompactDialogueSnapshot(value, spoken) !== 1) return false;
        const speaker = extractDialogueSpeakerSnapshot(line);
        if (speaker) {
            const escaped = escapeRegExp(speaker).replace(/\\s\+/g, '\\s*');
            const speakerPattern = new RegExp(`(?:<voice>\\s*${escaped}\\s*<\\/voice>|${escaped}\\s*[:：])`, 'i');
            if (!speakerPattern.test(value)) return false;
        }
    }
    return true;
}

function extractDialogueSpeakerSnapshot(line) {
    return String(line || '').match(/^\s*([^:：\n]{1,40})\s*[:：]/)?.[1]?.trim() || '';
}

function stripDialogueSpeakerSnapshot(line) {
    return String(line || '').replace(/^\s*[^:：\n]{1,40}\s*[:：]\s*/, '').trim();
}

function compactDialogueSnapshot(value) {
    return String(value || '')
        .replace(/[“”「」『』"'‘’]/g, '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。！？；：、,.!?;:]+/g, '')
        .toLocaleLowerCase();
}

function countCompactDialogueSnapshot(value, needle) {
    const source = compactDialogueSnapshot(value);
    const target = compactDialogueSnapshot(needle);
    if (!source || !target) return 0;
    let count = 0;
    let offset = source.indexOf(target);
    while (offset >= 0) {
        count++;
        offset = source.indexOf(target, offset + target.length);
    }
    return count;
}

function hasLegacyLocalH3FrameSemantics(prompt) {
    return /(?:\bfirst(?:[-_ ]frame)\b|\blast(?:[-_ ]frame)\b|\btail(?:[-_ ]frame)\b|\bopening(?:[-_ ]frame)\b|\bframe[-_ ]?0\b|\bprevious\s+shot['’]?s?\s+tail\b|\bR2V\s+OPENING\s+FRAME\b|首尾帧|首帧|第一帧|尾帧|第\s*0\s*帧)/i.test(String(prompt || ''));
}
function historyStepReuseScore(step, provider) {
    let score = Number(step.id || 0);
    if (hasReusableTailFrame(step, provider))
        score += 1_000_000;
    if (step.assetRefs)
        score += 100_000;
    if (String(step.status || '').toLowerCase() === 'completed')
        score += 10_000;
    return score;
}
function hasReusableTailFrame(step, provider) {
    const normalizedProvider = String(provider || '').toLowerCase();
    // Local H3 does not have a tail-frame contract.  Only the new neutral
    // continuity-reference fields may seed the next Picture 1 slot; legacy
    // tailFrameUrl rows are intentionally treated as stale.
    if (normalizedProvider === 'comfyui') {
        // A local step is reusable only when the current pipeline explicitly
        // wrote a neutral continuity reference. Any legacy tail/first-frame
        // column, even on a minimal row without a prompt, is rejected.
        return !!continuityReferenceUrlFromStep(step, { allowLegacyTail: false })
            && !isLegacyLocalH3SequenceStep(step);
    }
    if (!step?.tailFrameUrl)
        return false;
    // Local ComfyUI keeps the tail frame as a local static path instead of a
    // Volc Asset URI, so the path itself is the reusable continuity reference.
    return normalizedProvider === 'grok_openai'
        || normalizedProvider === 'comfyui'
        || !!step.tailFrameAssetId;
}
function hasReusableContinuityReference(step, provider) {
    const local = String(provider || '').trim().toLowerCase() === 'comfyui';
    const url = local
        ? continuityReferenceUrlFromStep(step, { allowLegacyTail: false })
        : step?.tailFrameUrl;
    if (!url && local) return hasReusableTailFrame(step, provider);
    if (!url) return false;
    return local || String(step?.tailFrameAssetId || '').trim().length > 0 || String(step?.tail_frame_asset_id || '').trim().length > 0;
}
export async function startVideoSequence(input) {
    const config = input.configId ? getConfigById(Number(input.configId)) : null;
    if (!config || !['mijing', 'grok_openai', 'comfyui', 'autodl_comfyui'].includes(String(config.provider || '').toLowerCase())) {
        throw new Error('一键串行生成仅支持谜镜、Grok Imagine、本地 ComfyUI MiniMax H3 或 AutoDL ComfyUI 视频通道，请选择对应的视频配置');
    }
    const model = String(input.model || config.model || '').trim();
    if (!model)
        throw new Error('串行视频模型未配置');
    const storyboards = getEpisodeStoryboards(input.episodeId);
    if (!storyboards.length)
        throw new Error('当前集没有可生成的分镜');
    const requestedStart = Number(input.startStoryboardNumber || 0);
    assertLocalSequenceContinuityMode(config.provider, input.continuityMode);
    const continuityMode = normalizeContinuityMode(input.continuityMode, config.provider);
    if (continuityMode === LOCAL_LATENT_PLUS && String(config.provider || '').trim().toLowerCase() !== 'comfyui') {
        throw new Error('H3 latent Plus 仅支持本地 ComfyUI MiniMax H3');
    }
    const hasExplicitStart = Number.isInteger(requestedStart) && requestedStart > 0;
    // Resolve the requested storyboard number against the ordered rows rather
    // than assuming `number - 1` is always the array index. This keeps the
    // range selector correct after inserts/deletions or imported storyboards.
    const startIndex = hasExplicitStart
        ? storyboards.findIndex((storyboard, index) => Number(storyboard.storyboardNumber || storyboard.storyboard_number || index + 1) === requestedStart)
        : 0;
    if (hasExplicitStart && (startIndex < 0 || startIndex >= storyboards.length)) {
        throw new Error(`起始分镜必须在 1-${storyboards.length} 之间`);
    }
    const existing = db.select().from(schema.videoSequenceRuns).all()
        .filter(row => row.episodeId === input.episodeId && ['queued', 'running', 'paused'].includes(String(row.status)))
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (existing) {
        // Re-decomposition can happen while a worker is still running.  The
        // old live run then contains a stale prompt/reference snapshot and
        // must not be resumed just because it is still marked processing.
        const latestStoryboardRevision = storyboards.reduce((latest, storyboard) => {
            const value = Date.parse(String(storyboard.updatedAt || ''));
            return Number.isFinite(value) ? Math.max(latest, value) : latest;
        }, Number.NEGATIVE_INFINITY);
        const existingRevision = Date.parse(String(existing.createdAt || existing.created_at || ''));
        const existingSteps = db.select().from(schema.videoSequenceSteps).all()
            .filter(step => Number(step.runId) === Number(existing.id));
        const staleExistingRun = isLegacyLocalH3SequenceRun(existing, existingSteps)
            || (String(config.provider || '').trim().toLowerCase() === 'comfyui'
                && String(existing.model || '').trim() !== model)
            || normalizeContinuityMode(existing.continuityMode || existing.continuity_mode, existing.provider) !== continuityMode
            || (Number.isFinite(latestStoryboardRevision)
                && Number.isFinite(existingRevision)
                && existingRevision < latestStoryboardRevision);
        // An explicit start selection is a user command to create a fresh
        // sequence boundary.  Reusing the live run here makes "全部重新生成"
        // silently continue at its old current index (for example shot 5),
        // even though the request carries start_storyboard_number=1.  Cancel
        // the old worker before building the new reuse plan; the explicit
        // force boundary below then invalidates every shot at/after the
        // selected index, including a full restart at index 0.
        if (staleExistingRun || hasExplicitStart) {
            cancelVideoSequence(existing.id);
        }
        else {
            ensureSequenceWorker(existing.id);
            return getVideoSequence(existing.id);
        }
    }
    const ts = now();
    let reuseForceFromIndex = hasExplicitStart ? startIndex : undefined;
    let reusePlan = buildVideoSequenceReusePlan({
        storyboards,
        videoGenerations: db.select().from(schema.videoGenerations).all(),
        historicalSteps: db.select().from(schema.videoSequenceSteps).all(),
        provider: config.provider,
        continuityMode,
        config,
        model,
        forceFromIndex: reuseForceFromIndex,
        preservePrefixUntilIndex: hasExplicitStart && continuityMode === LOCAL_LATENT_PLUS ? startIndex : undefined,
    });
    // A latent_plus chain cannot safely reuse an old standard-R2V shot: the
    // PNG tail is not equivalent to the H3 AV latent consumed by Motion
    // Context. Find the first reused shot without a verifiable indexed latent
    // and regenerate from that boundary. For an explicitly selected start,
    // fail instead of silently falling back to PNG continuity.
    if (continuityMode === LOCAL_LATENT_PLUS) {
        const generations = db.select().from(schema.videoGenerations).all();
        const requiredPreviousIndex = hasExplicitStart ? startIndex - 1 : null;
        const firstUnsafeIndex = reusePlan.findIndex((item, index) => {
            if (requiredPreviousIndex != null && index !== requiredPreviousIndex)
                return false;
            if (!item.reused || !item.historyStep)
                return requiredPreviousIndex != null
                    ? index === requiredPreviousIndex
                    : item.reused && !item.historyStep && !!item.videoGenerationId;
            const history = item.historyStep;
            const generation = generations.find(row => Number(row.id) === Number(item.videoGenerationId));
            const latentPath = history.latentPath || generation?.latentPath;
            const clipIndex = Number(history.latentClipIndex || generation?.latentClipIndex);
            return !latentPath || !Number.isFinite(clipIndex) || clipIndex < 1
                || !latentSlotExistsForPath(latentPath, clipIndex, config);
        });
        if (firstUnsafeIndex >= 0) {
            if (hasExplicitStart && firstUnsafeIndex < startIndex) {
                const number = storyboards[firstUnsafeIndex]?.storyboardNumber || firstUnsafeIndex + 1;
                throw new Error(`无法从第 ${requestedStart} 个分镜启动 H3 Motion Context Plus：前置分镜 ${number} 缺少可读取的 latent 文件，请从第 ${number} 个分镜重新生成`);
            }
            reuseForceFromIndex = Math.min(reuseForceFromIndex ?? storyboards.length, firstUnsafeIndex);
            reusePlan = buildVideoSequenceReusePlan({
                storyboards,
                videoGenerations: generations,
                historicalSteps: db.select().from(schema.videoSequenceSteps).all(),
                provider: config.provider,
                continuityMode,
                config,
                model,
                forceFromIndex: reuseForceFromIndex,
                preservePrefixUntilIndex: hasExplicitStart && continuityMode === LOCAL_LATENT_PLUS ? startIndex : undefined,
            });
        }
    }
    if (hasExplicitStart) {
        const missingPrevious = continuityMode === LOCAL_LATENT_PLUS
            ? (startIndex > 0
                && (!reusePlan[startIndex - 1]
                    || reusePlan[startIndex - 1].status !== 'skipped'
                    || !reusePlan[startIndex - 1].reused)
                ? reusePlan[startIndex - 1]
                : null)
            : reusePlan.slice(0, startIndex).find((item, index) => {
                const boundaryTailPreparation = index === startIndex - 1 && item.reused && item.needsTailPreparation;
                return !boundaryTailPreparation && (item.status !== 'skipped' || !item.reused);
            });
        if (missingPrevious) {
            const missingNumber = storyboards.find(item => item.id === missingPrevious.storyboardId)?.storyboardNumber || missingPrevious.storyboardId;
            throw new Error(`无法从第 ${requestedStart} 个分镜开始：前置分镜 ${missingNumber} 没有可用的已完成视频或连续参考图`);
        }
    }
    const firstPending = reusePlan.find(item => item.status === 'pending');
    const allVideosReused = !firstPending;
    const runResult = db.insert(schema.videoSequenceRuns).values({
        dramaId: input.dramaId,
        episodeId: input.episodeId,
        provider: config.provider,
        model,
        configId: input.configId || config.id || null,
        aspectRatio: input.aspectRatio || '16:9',
        megapixels: input.megapixels || 1,
        samplingSteps: input.steps || 4,
        loraStrength: normalizeSequenceLoraStrength(input.loraStrength),
        continuityMode,
        status: allVideosReused ? 'completed' : 'queued',
        currentIndex: firstPending ? storyboards.findIndex(item => item.id === firstPending.storyboardId) : storyboards.length,
        totalCount: storyboards.length,
        currentStoryboardId: firstPending?.storyboardId || null,
        createdAt: ts,
        updatedAt: ts,
        completedAt: allVideosReused ? ts : null,
    }).run();
    const runId = Number(runResult.lastInsertRowid);
    const latentPath = continuityMode === LOCAL_LATENT_PLUS ? latentDirectoryForRun(runId) : null;
    if (continuityMode === LOCAL_LATENT_PLUS) {
        const firstPendingIndex = firstPending ? storyboards.findIndex(item => item.id === firstPending.storyboardId) : storyboards.length;
        const previousPrefixIndex = firstPendingIndex - 1;
        const previousPrefixItem = previousPrefixIndex >= 0 ? reusePlan[previousPrefixIndex] : null;
        if (previousPrefixItem) {
            const generations = db.select().from(schema.videoGenerations).all();
            const history = previousPrefixItem.historyStep;
            const generation = generations.find(row => Number(row.id) === Number(previousPrefixItem.videoGenerationId));
            const sourcePath = history?.latentPath || generation?.latentPath;
            const clipIndex = Number(history?.latentClipIndex || generation?.latentClipIndex || previousPrefixIndex + 1);
            if (!sourcePath || !Number.isFinite(clipIndex) || clipIndex < 1) {
                    throw new Error('H3 Motion Context Plus 缺少前置 latent，无法安全衔接；请从第一个分镜重新生成');
                }
            copyLatentSlot(sourcePath, latentPath, clipIndex, config);
        }
    }
    storyboards.forEach((storyboard, index) => {
        const plan = reusePlan[index];
        const history = plan.historyStep;
        db.insert(schema.videoSequenceSteps).values({
            runId,
            storyboardId: storyboard.id,
            stepIndex: index,
            storyboardNumber: storyboard.storyboardNumber,
            status: plan.status,
            videoGenerationId: plan.videoGenerationId,
             firstFrameLocalPath: null,
             firstFrameUrl: null,
             firstFrameAssetId: null,
             firstFrameAssetUri: null,
             continuityReferenceLocalPath: history?.continuityReferenceLocalPath || history?.continuity_reference_local_path || (String(config.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameLocalPath || history?.tail_frame_local_path || null),
             continuityReferenceUrl: history?.continuityReferenceUrl || history?.continuity_reference_url || (String(config.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameUrl || history?.tail_frame_url || null),
             continuityReferenceAssetId: history?.continuityReferenceAssetId || history?.continuity_reference_asset_id || (String(config.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameAssetId || history?.tail_frame_asset_id || null),
             continuityReferenceAssetUri: history?.continuityReferenceAssetUri || history?.continuity_reference_asset_uri || (String(config.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameAssetUri || history?.tail_frame_asset_uri || null),
             tailFrameLocalPath: null,
             tailFrameUrl: null,
             tailFrameAssetId: null,
             tailFrameAssetUri: null,
            assetIds: history?.assetIds || null,
            assetRefs: history?.assetRefs || null,
            referenceImageUrls: history?.referenceImageUrls || null,
            prompt: history?.prompt || null,
            latentPath,
            latentClipIndex: continuityMode === LOCAL_LATENT_PLUS ? index + 1 : null,
            createdAt: ts,
            updatedAt: ts,
            completedAt: plan.status === 'skipped' ? ts : null,
        }).run();
    });
    logTaskProgress('VideoSequence', 'reuse-plan-created', {
        runId,
        reusedCount: reusePlan.filter(item => item.reused).length,
        skippedCount: reusePlan.filter(item => item.status === 'skipped').length,
        tailPreparationCount: reusePlan.filter(item => item.needsTailPreparation).length,
        generationCount: reusePlan.filter(item => !item.reused).length,
    });
    if (!allVideosReused)
        ensureSequenceWorker(runId);
    return getVideoSequence(runId);
}
export function getVideoSequence(runId) {
    const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
    if (!run)
        return null;
    const steps = db.select().from(schema.videoSequenceSteps)
        .where(eq(schema.videoSequenceSteps.runId, runId)).all()
        .sort((a, b) => a.stepIndex - b.stepIndex);
    // A local H3 run that still contains the retired frame-slot contract is
    // historical data, not a resumable/current run. Never expose it through
    // the polling endpoint, including while it is marked active: returning an
    // active legacy snapshot lets the UI display the old role bindings and
    // allows a worker/retry to re-enter the retired chain.
    if (isLegacyLocalH3SequenceRun(run, steps)) {
        return null;
    }
    return {
        ...run,
        // Sanitize the public/worker snapshot as well as the episode view. A
        // Plus worker never consumes PNG frame columns, so clearing legacy
        // values here cannot affect latent scheduling but prevents a stale
        // row from re-entering the UI through /sequential/:runId polling.
        steps: enrichSequenceStepErrors(sanitizeSequenceStepsForMode(steps, run.continuityMode, run.provider), db.select().from(schema.videoGenerations).all()),
    };
}

/**
 * Motion Context Plus is a latent-only chain.  Older runs (and rows restored
 * from the standard R2V path) may still contain PNG first/tail-frame columns
 * or a `first_frame` asset binding.  Never expose those legacy values through
 * the API: the frontend would otherwise render “提取尾帧” and a stale tail
 * could be mistaken for the current shot's reference image.
 */
export function sanitizeSequenceStepForMode(step, continuityMode, provider) {
    if (String(provider || '').trim().toLowerCase() !== 'comfyui')
        return step;
    const isLatentPlus = normalizeContinuityMode(continuityMode, provider) === LOCAL_LATENT_PLUS;
    const result = {
        ...step,
        firstFrameLocalPath: null,
        firstFrameUrl: null,
        firstFrameAssetId: null,
        firstFrameAssetUri: null,
        // Local H3 continuity is carried by Video 1 or AV latent. Never
        // expose a continuity still as a current Picture reference.
        continuityReferenceLocalPath: null,
        continuityReferenceUrl: null,
        continuityReferenceAssetId: null,
        continuityReferenceAssetUri: null,
        ...(isLatentPlus ? {
            tailFrameLocalPath: null,
            tailFrameUrl: null,
            tailFrameAssetId: null,
            tailFrameAssetUri: null,
        } : {}),
    };
    // Older runs persisted the retired wording directly in the step prompt.
    // Normalize that snapshot before it reaches the UI or a resume path so a
    // stale run can never advertise/restore a provider first/last-frame flow.
    if (step?.prompt != null)
        result.prompt = sanitizeLocalH3Prompt(step.prompt);
    if (step?.finalPrompt != null)
        result.finalPrompt = sanitizeLocalH3Prompt(step.finalPrompt);
    // Motion Context Plus is latent-only.  A cached step from the retired
    // frame-chain path must not leak any PNG continuity value back into the
    // worker snapshot (or the UI), otherwise the next request can silently
    // mix latent continuity with an old Picture-1 image.
    // Keep the snake_case fields used by API responses in sync with the
    // camelCase Drizzle row fields. Vue can receive either shape depending on
    // which endpoint supplied the snapshot.
    result.first_frame_local_path = null;
    result.first_frame_url = null;
    result.first_frame_asset_id = null;
    result.first_frame_asset_uri = null;
    result.continuity_reference_local_path = null;
    result.continuity_reference_url = null;
    result.continuity_reference_asset_id = null;
    result.continuity_reference_asset_uri = null;
    if (isLatentPlus || String(provider || '').trim().toLowerCase() === 'comfyui') {
        result.tail_frame_local_path = null;
        result.tail_frame_url = null;
        result.tail_frame_asset_id = null;
        result.tail_frame_asset_uri = null;
        result.tailFrameLocalPath = null;
        result.tailFrameUrl = null;
        result.tailFrameAssetId = null;
        result.tailFrameAssetUri = null;
    }
    const rawRefs = step?.assetRefs ?? step?.asset_refs;
    let hadLegacyFrameRef = false;
    let legacyFrameSources = [];
    if (rawRefs != null) {
        try {
            const parsed = Array.isArray(rawRefs) ? rawRefs : JSON.parse(String(rawRefs || '[]'));
            if (Array.isArray(parsed)) {
                const frameRefs = parsed.filter(item => ['first_frame', 'last_frame', CONTINUITY_REFERENCE_ROLE].includes(String(item?.role || '').trim().toLowerCase()));
                hadLegacyFrameRef = frameRefs.length > 0;
                legacyFrameSources = frameRefs.flatMap(item => [item?.url, item?.asset_uri, item?.assetUri, item?.public_url, item?.publicUrl].filter(Boolean).map(value => referenceSourceKey(value)));
                // Do not convert a legacy first_frame binding into the neutral
                // continuity role. That would make an old FL2VA/I2V snapshot
                // look like a valid R2V snapshot and is the exact path that
                // reintroduced the wrong protagonist after re-decomposition.
                // The run is rejected by isLegacyLocalH3SequenceRun; this
                // filtering is only a defensive display cleanup.
                const kept = parsed
                    .filter(item => !['first_frame', 'last_frame', CONTINUITY_REFERENCE_ROLE].includes(String(item?.role || '').trim().toLowerCase()));
                const serialized = JSON.stringify(kept);
                result.assetRefs = serialized;
                result.asset_refs = serialized;
            }
        }
        catch {
            // Keep the row readable even if a legacy asset_refs value was
            // malformed; the frame columns above are still safely cleared.
        }
    }
    const rawImages = step?.referenceImageUrls ?? step?.reference_image_urls;
    if (rawImages != null) {
        try {
            const parsed = Array.isArray(rawImages) ? rawImages : JSON.parse(String(rawImages || '[]'));
            if (Array.isArray(parsed)) {
                // Legacy Plus rows stored the previous tail as Picture 1 while
                // also tagging it as first_frame.  The old asset_refs rows did
                // not persist a URL, so remove the first image whenever that
                // semantic frame tag is present; when a URL is available use
                // exact source matching to avoid dropping a real R2V asset.
                const filtered = parsed.filter((value, index) => {
                    if (!isLatentPlus || !hadLegacyFrameRef) return true;
                    const key = referenceSourceKey(value);
                    if (key && legacyFrameSources.includes(key)) return false;
                    return index !== 0;
                });
                const serialized = JSON.stringify(filtered);
                result.referenceImageUrls = serialized;
                result.reference_image_urls = serialized;
            }
        }
        catch {
            // Keep the original value if it cannot be parsed; frame fields and
            // role bindings are still removed above.
        }
    }
    // Local MiniMax H3 is always submitted as an ordered multi-reference R2V
    // request. `extracting_tail` was an internal/legacy phase from the old
    // first/last-frame workflow; exposing it makes the UI suggest FL2VA/I2V
    // even though the provider request has no first_frame_url/last_frame_url.
    // Keep the database row resumable, but never leak that phase to callers in
    // either standard R2V or Motion Context Plus mode.
    if (String(result.status || '').toLowerCase() === 'extracting_tail')
        result.status = 'processing';
    return result;
}

export function sanitizeSequenceStepsForMode(steps, continuityMode, provider) {
    return (steps || []).map(step => sanitizeSequenceStepForMode(step, continuityMode, provider));
}
/**
 * Preserve the provider's diagnostic on the sequence step returned to the UI.
 * Older runs can have a failed generation row while the step itself has a
 * null error_msg (for example when the process crashed between the two DB
 * updates). Without this fallback the card only shows the generic status.
 */
export function enrichSequenceStepErrors(steps, generations) {
    const byId = new Map(generations.map(generation => [Number(generation.id), generation]));
    return steps.map(step => {
        if (String(step.errorMsg || '').trim())
            return step;
        const generation = step.videoGenerationId ? byId.get(Number(step.videoGenerationId)) : null;
        const generationError = String(generation?.errorMsg || '').trim();
        if (generationError)
            return { ...step, errorMsg: generationError };
        if (String(step.status || '').toLowerCase() === 'failed') {
            return { ...step, errorMsg: '视频任务失败，但上游没有返回具体错误；请查看 Worker 日志后重试' };
        }
        return step;
    });
}
export function getEpisodeVideoSequence(episodeId) {
    const runs = db.select().from(schema.videoSequenceRuns).all()
        .filter(row => row.episodeId === episodeId)
        .sort((a, b) => Number(b.id) - Number(a.id));
    // A sequence run is a snapshot of the storyboard prompts and asset
    // bindings. Do not return a historical run after a re-decomposition. A
    // run is current only when it was created after the latest current
    // storyboard revision and contains the same shot set. This also keeps a
    // cancelled/failed current run visible for retry, while hiding an older
    // run whose prompt still contains the previous character mapping.
    const allGenerations = db.select().from(schema.videoGenerations).all();
    const storyboards = getEpisodeStoryboards(episodeId);
    const isCurrentRun = (candidate) => {
        const steps = db.select().from(schema.videoSequenceSteps).all()
            .filter(step => Number(step.runId) === Number(candidate.id));
        if (isLegacyLocalH3SequenceRun(candidate, steps))
            return false;
        const stepsByStoryboard = new Map(steps.map(step => [Number(step.storyboardId), step]));
        if (steps.length !== storyboards.length)
            return false;
        const runRevision = Date.parse(String(candidate.createdAt || candidate.created_at || ''));
        const latestStoryboardRevision = storyboards.reduce((latest, storyboard) => {
            const value = Date.parse(String(storyboard.updatedAt || ''));
            return Number.isFinite(value) ? Math.max(latest, value) : latest;
        }, Number.NEGATIVE_INFINITY);
        if (Number.isFinite(latestStoryboardRevision)
            && (!Number.isFinite(runRevision) || runRevision < latestStoryboardRevision))
            return false;
        for (const storyboard of storyboards) {
            const step = stepsByStoryboard.get(Number(storyboard.id));
            if (!step) return false;
            const latest = pickLatestVideoGeneration(allGenerations, storyboard.id);
            const currentGeneration = step.videoGenerationId
                ? allGenerations.find(item => Number(item.id) === Number(step.videoGenerationId) && !item.deletedAt)
                : null;
            // A generation row is a snapshot of both the storyboard revision
            // and the selected local H3 continuity mode.  Do not allow an old
            // standard/legacy row to make an otherwise current run appear
            // valid merely because it has the newest numeric id.  Completed
            // rows are checked strictly; an active/failed row is retained so
            // the user can still see and retry a current error.
            if (latest?.id
                && String(latest.status || '').toLowerCase() === 'completed'
                && !isGenerationCompatibleWithStoryboard(latest, storyboard, candidate.provider, candidate.continuityMode))
                return false;
            if (currentGeneration
                && String(currentGeneration.status || '').toLowerCase() === 'completed'
                && !isGenerationCompatibleWithStoryboard(currentGeneration, storyboard, candidate.provider, candidate.continuityMode))
                return false;
            // A newer generation not belonging to this run means this run is
            // stale; an old generation must never be displayed as current.
            if (latest?.id && Number(step.videoGenerationId || 0) !== Number(latest.id))
                return false;
            const storyboardRevision = Date.parse(String(storyboard.updatedAt || ''));
            const generationRevision = Date.parse(String(currentGeneration?.createdAt || currentGeneration?.created_at || ''));
            if (Number.isFinite(storyboardRevision)) {
                if (currentGeneration) {
                    if (!Number.isFinite(generationRevision) || generationRevision < storyboardRevision)
                        return false;
                }
                else if (!Number.isFinite(runRevision) || runRevision < storyboardRevision) {
                    return false;
                }
            }
        }
        return true;
    };
    const run = runs.find(isCurrentRun);
    const sequence = run ? getVideoSequence(run.id) : null;
    if (!sequence)
        return null;
    return {
        ...sequence,
        steps: enrichSequenceStepsForDisplay({
            steps: sequence.steps,
            historicalSteps: db.select().from(schema.videoSequenceSteps).all(),
            videoGenerations: db.select().from(schema.videoGenerations).all(),
            continuityMode: sequence.continuityMode,
            provider: sequence.provider,
        }),
    };
}
export function enrichSequenceStepsForDisplay(input) {
    const sanitizedSteps = sanitizeSequenceStepsForMode(input.steps, input.continuityMode, input.provider);
    const sanitizedHistory = sanitizeSequenceStepsForMode(input.historicalSteps, input.continuityMode, input.provider);
    return sanitizedSteps.map((step) => {
        const storyboard = input.storyboards?.find(item => Number(item.id) === Number(step.storyboardId)) || getStoryboard(step.storyboardId);
        const generationId = Number(step.videoGenerationId || step.video_generation_id || 0);
        const boundGeneration = generationId
            ? input.videoGenerations.find(item => Number(item.id) === generationId && !item.deletedAt && !item.deleted_at)
            : null;
        const boundGenerationIsStale = boundGeneration
            && String(boundGeneration.status || '').toLowerCase() === 'completed'
            && !isGenerationCompatibleWithStoryboard(boundGeneration, storyboard, input.provider, input.continuityMode);
        // Never expose an old asset/prompt snapshot through a direct run
        // lookup.  Keep the historical row in the database for audit, but
        // detach it from the current display/retry state.
        if (boundGenerationIsStale) {
            return {
                ...step,
                status: String(step.status || '').toLowerCase() === 'completed' ? 'pending' : step.status,
                videoGenerationId: null,
                video_generation_id: null,
                assetIds: null,
                asset_ids: null,
                assetRefs: null,
                asset_refs: null,
                referenceImageUrls: null,
                reference_image_urls: null,
                prompt: null,
            };
        }
        if (step.assetRefs)
            return step;
        // Pick the newest row first, then validate it.  Filtering for
        // compatibility before sorting would incorrectly fall back to an
        // older valid generation when a newer (but incompatible) snapshot is
        // present; that is precisely how stale character mappings re-entered
        // the current UI after a re-decomposition.
        const newestGeneration = pickLatestVideoGeneration(input.videoGenerations || [], step.storyboardId);
        const generation = newestGeneration
            && isCompletedVideoGeneration(newestGeneration)
            && (!storyboard || isGenerationCompatibleWithStoryboard(newestGeneration, storyboard, input.provider, input.continuityMode))
            ? newestGeneration
            : null;
        if (!generation?.id)
            return step;
        const history = sanitizedHistory
            .filter(item => Number(item.storyboardId) === Number(step.storyboardId)
            && Number(item.videoGenerationId || 0) === Number(generation.id)
            && !!item.assetRefs)
            .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
        if (!history)
            return step;
        return {
            ...step,
            videoGenerationId: step.videoGenerationId || Number(generation.id),
            assetIds: history.assetIds || null,
            assetRefs: history.assetRefs || null,
            referenceImageUrls: history.referenceImageUrls || null,
            prompt: step.prompt || history.prompt || null,
        };
    });
}
export function ensureSequenceWorker(runId) {
    if (activeRuns.has(runId))
        return false;
    reconcilePendingSequenceSteps(runId);
    const run = getVideoSequence(runId);
    if (!run || ['completed', 'cancelled'].includes(String(run.status)))
        return false;
    activeRuns.add(runId);
    processSequence(runId).catch(error => {
        logTaskError('VideoSequence', 'worker-crashed', { runId, error: error?.message || String(error) });
        markRunFailed(runId, error?.message || String(error));
    }).finally(() => activeRuns.delete(runId));
    return true;
}
function reconcilePendingSequenceSteps(runId) {
    const sequence = getVideoSequence(runId);
    if (!sequence || !['queued', 'running', 'paused'].includes(String(sequence.status)))
        return;
    const storyboards = getEpisodeStoryboards(sequence.episodeId);
    const plan = buildVideoSequenceReusePlan({
        storyboards,
        videoGenerations: db.select().from(schema.videoGenerations).all(),
        historicalSteps: db.select().from(schema.videoSequenceSteps).all(),
        provider: sequence.provider,
        continuityMode: sequence.continuityMode,
        config: sequence.configId ? getConfigById(Number(sequence.configId)) : null,
        model: sequence.model,
        // Preserve the selected-start boundary from the run's pending rows. A
        // selected run intentionally has no generation id on the first shot to be
        // regenerated; deriving the boundary from those rows survives restarts
        // without adding another database column.
        forceFromIndex: sequence.steps.find(step => String(step.status) === 'pending' && !step.videoGenerationId)?.stepIndex,
    });
    const planByStoryboard = new Map(plan.map(item => [item.storyboardId, item]));
    const timestamp = now();
    let changed = 0;
    for (const step of sequence.steps) {
        if (String(step.status) !== 'pending')
            continue;
        const existingGeneration = step.videoGenerationId ? getVideoGeneration(step.videoGenerationId) : null;
        if (existingGeneration && !existingGeneration.deletedAt && existingGeneration.status !== 'completed')
            continue;
        const item = planByStoryboard.get(step.storyboardId);
        if (!item?.reused || !item.videoGenerationId)
            continue;
        const history = item.historyStep;
        db.update(schema.videoSequenceSteps).set({
            status: item.status,
            videoGenerationId: item.videoGenerationId,
            // Local MiniMax H3 is R2V-only in both serial modes.  Never copy
            // legacy provider first-frame columns back into a recovered step;
            // standard R2V carries continuity only in Picture 1 and Plus only
            // in the AV latent.  Remote providers retain their historical
            // first-frame fields through their own non-ComfyUI paths.
            firstFrameLocalPath: String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : (history?.firstFrameLocalPath || step.firstFrameLocalPath || null),
            firstFrameUrl: String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : (history?.firstFrameUrl || step.firstFrameUrl || null),
            firstFrameAssetId: String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : (history?.firstFrameAssetId || step.firstFrameAssetId || null),
            firstFrameAssetUri: String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : (history?.firstFrameAssetUri || step.firstFrameAssetUri || null),
            continuityReferenceLocalPath: history?.continuityReferenceLocalPath || history?.continuity_reference_local_path || step.continuityReferenceLocalPath || step.continuity_reference_local_path || (String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameLocalPath || history?.tail_frame_local_path || step.tailFrameLocalPath || step.tail_frame_local_path || null),
            continuityReferenceUrl: history?.continuityReferenceUrl || history?.continuity_reference_url || step.continuityReferenceUrl || step.continuity_reference_url || (String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameUrl || history?.tail_frame_url || step.tailFrameUrl || step.tail_frame_url || null),
            continuityReferenceAssetId: history?.continuityReferenceAssetId || history?.continuity_reference_asset_id || step.continuityReferenceAssetId || step.continuity_reference_asset_id || (String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameAssetId || history?.tail_frame_asset_id || step.tailFrameAssetId || step.tail_frame_asset_id || null),
            continuityReferenceAssetUri: history?.continuityReferenceAssetUri || history?.continuity_reference_asset_uri || step.continuityReferenceAssetUri || step.continuity_reference_asset_uri || (String(sequence.provider || '').toLowerCase() === 'comfyui' ? null : history?.tailFrameAssetUri || history?.tail_frame_asset_uri || step.tailFrameAssetUri || step.tail_frame_asset_uri || null),
            tailFrameLocalPath: null,
            tailFrameUrl: null,
            tailFrameAssetId: null,
            tailFrameAssetUri: null,
            assetIds: history?.assetIds || step.assetIds || null,
            assetRefs: history?.assetRefs || step.assetRefs || null,
            referenceImageUrls: history?.referenceImageUrls || step.referenceImageUrls || null,
            prompt: history?.prompt || step.prompt || null,
            completedAt: item.status === 'skipped' ? timestamp : null,
            updatedAt: timestamp,
        }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
        changed += 1;
    }
    if (!changed)
        return;
    const current = getVideoSequence(runId);
    const next = current?.steps.find(step => !['completed', 'skipped'].includes(String(step.status)));
    if (next) {
        db.update(schema.videoSequenceRuns).set({
            currentIndex: next.stepIndex,
            currentStoryboardId: next.storyboardId,
            updatedAt: timestamp,
        }).where(eq(schema.videoSequenceRuns.id, runId)).run();
    }
    else {
        setRunStatus(runId, 'completed', {
            completedAt: timestamp,
            currentIndex: sequence.totalCount,
            currentStoryboardId: null,
            errorMsg: null,
        });
    }
    logTaskProgress('VideoSequence', 'pending-steps-reconciled', { runId, changed });
}
export function resumeVideoSequences(reason = 'startup') {
    const runs = db.select().from(schema.videoSequenceRuns).all()
        .filter(run => ['queued', 'running', 'paused'].includes(String(run.status)));
    let resumed = 0;
    let cancelledLegacy = 0;
    for (const run of runs) {
        const steps = db.select().from(schema.videoSequenceSteps).all()
            .filter(step => Number(step.runId) === Number(run.id));
        if (isLegacyLocalH3SequenceRun(run, steps)) {
            // Never restart an old local run after a desktop restart. Its
            // snapshot may contain first/last/tail-frame bindings and stale
            // character mappings; a new R2V run must be created instead.
            cancelVideoSequence(run.id);
            cancelledLegacy += 1;
            continue;
        }
        ensureSequenceWorker(run.id);
        resumed += 1;
    }
    logTaskProgress('VideoSequence', 'resume-scan', { reason, count: resumed, cancelledLegacy });
    return resumed;
}
export function cancelVideoSequence(runId) {
    const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
    if (!run)
        return null;
    if (!['completed', 'failed', 'cancelled'].includes(String(run.status))) {
        db.update(schema.videoSequenceRuns).set({ status: 'cancelled', errorMsg: '用户停止串行生成', updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, runId)).run();
        const steps = db.select().from(schema.videoSequenceSteps).where(eq(schema.videoSequenceSteps.runId, runId)).all();
        for (const step of steps.filter(item => !['completed', 'skipped', 'failed', 'cancelled'].includes(String(item.status)))) {
            db.update(schema.videoSequenceSteps).set({ status: 'cancelled', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
        }
    }
    // The generation row is polled independently from the sequence worker.
    // Synchronize unfinished children even when the parent was already
    // cancelled (for example after a desktop crash before the original
    // cancel request reached this process); completed history stays intact.
    const generations = db.select().from(schema.videoGenerations)
        .where(eq(schema.videoGenerations.sequenceRunId, runId)).all();
    for (const generation of generations.filter(item => ['pending', 'processing', 'queued', 'running'].includes(String(item.status || '').toLowerCase()))) {
        db.update(schema.videoGenerations)
            .set({ status: 'cancelled', errorMsg: '用户停止串行生成', updatedAt: now() })
            .where(eq(schema.videoGenerations.id, generation.id)).run();
    }
    return getVideoSequence(runId);
}
export function retryVideoSequence(runId) {
    const sequence = getVideoSequence(runId);
    if (!sequence)
        throw new Error('串行任务不存在');
    if (sequence.status !== 'failed')
        throw new Error('当前串行任务没有失败步骤');
    const failed = sequence.steps.find(step => step.status === 'failed');
    if (!failed)
        throw new Error('没有可重试的失败镜头');
    const failedGeneration = failed.videoGenerationId ? getVideoGeneration(failed.videoGenerationId) : null;
    const normalizedProvider = String(sequence.provider || '').trim().toLowerCase();
    const isLatentPlus = normalizedProvider === 'comfyui'
        && normalizeContinuityMode(sequence.continuityMode, normalizedProvider) === LOCAL_LATENT_PLUS;
    const config = sequence.configId ? getConfigById(Number(sequence.configId)) : null;
    const failedLatentPath = failed.latentPath || failedGeneration?.latentPath;
    const failedClipIndex = Number(failed.latentClipIndex || failedGeneration?.latentClipIndex || failed.stepIndex + 1);
    const latentReady = !isLatentPlus
        || (!!failedLatentPath && latentSlotExistsForPath(failedLatentPath, failedClipIndex, config));
    const reuseCompletedGeneration = shouldReuseCompletedGenerationOnSequenceRetry({
        generationStatus: failedGeneration?.status,
        generationDeletedAt: failedGeneration?.deletedAt,
        isLatentPlus,
        latentReady,
    });
    if (failedGeneration && !failedGeneration.deletedAt && !reuseCompletedGeneration) {
        db.update(schema.videoGenerations)
            .set({ deletedAt: now(), updatedAt: now() })
            .where(eq(schema.videoGenerations.id, failedGeneration.id))
            .run();
    }
    db.update(schema.videoSequenceRuns).set({ status: 'queued', errorMsg: null, currentIndex: failed.stepIndex, currentStoryboardId: failed.storyboardId, updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, runId)).run();
    db.update(schema.videoSequenceSteps).set({
        status: 'pending',
        videoGenerationId: reuseCompletedGeneration ? failedGeneration.id : null,
        errorMsg: null,
        updatedAt: now(),
    })
        .where(and(eq(schema.videoSequenceSteps.runId, runId), eq(schema.videoSequenceSteps.stepIndex, failed.stepIndex))).run();
    ensureSequenceWorker(runId);
    return getVideoSequence(runId);
}
/**
 * A completed MP4 is not enough to resume a Plus chain. The next shot consumes
 * the sampler's AV latent, so a retry after a missing-latent failure must
 * regenerate the failed shot instead of falsely accepting its video file.
 */
export function shouldReuseCompletedGenerationOnSequenceRetry(input) {
    const completed = String(input?.generationStatus || '').trim().toLowerCase() === 'completed'
        && !input?.generationDeletedAt;
    return completed && (!input?.isLatentPlus || input?.latentReady === true);
}
async function processSequence(runId) {
    const initial = getVideoSequence(runId);
    if (!initial)
        return;
    setRunStatus(runId, 'running');
    for (;;) {
        const sequence = getVideoSequence(runId);
        if (!sequence || ['cancelled', 'completed'].includes(String(sequence.status)))
            return;
        resetStaleSequenceSteps(sequence);
        const current = getVideoSequence(runId);
        if (!current || ['cancelled', 'completed'].includes(String(current.status)))
            return;
        const step = current.steps.find(item => ['pending', 'running', 'preparing', 'submitting', 'processing', 'extracting_tail'].includes(String(item.status)));
        if (!step) {
            setRunStatus(runId, 'completed', { completedAt: now(), currentIndex: sequence.totalCount, currentStoryboardId: null });
            return;
        }
        try {
            await processStep(current, step);
        }
        catch (error) {
            const [latestRun] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
            if (error instanceof SequenceCancelledError || latestRun?.status === 'cancelled')
                return;
            const message = error?.message || String(error);
            db.update(schema.videoSequenceSteps).set({ status: 'failed', errorMsg: message, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
            markRunFailed(runId, message, step.storyboardId);
            logTaskError('VideoSequence', 'step-failed', { runId, stepId: step.id, storyboardId: step.storyboardId, error: message });
            return;
        }
    }
}
function resetStaleSequenceSteps(sequence) {
    const continuityBoundaryIndex = Math.max(0, Number(sequence.currentIndex || 0) - 1);
    const restartIndex = sequence.steps
        .filter(step => {
        if (Number(step.stepIndex) < continuityBoundaryIndex)
            return false;
        if (!step.videoGenerationId)
            return false;
        const generation = getVideoGeneration(step.videoGenerationId);
        if (!generation || !!generation.deletedAt)
            return true;
        // A storyboard can be re-decomposed while a serial worker is still
        // running. The already-completed step then points at a generation
        // built from the previous role/scene whitelist. Treat that row as
        // stale immediately and invalidate the complete downstream chain;
        // otherwise the worker would continue from a frame containing the old
        // protagonist or an old asset mapping.
        const storyboard = getStoryboard(step.storyboardId);
        if (!storyboard)
            return true;
        return String(generation.status || '').toLowerCase() === 'completed'
            && !isGenerationCompatibleWithStoryboard(
                generation,
                storyboard,
                sequence.provider,
                sequence.continuityMode,
            );
    })
        .reduce((min, step) => min == null ? step.stepIndex : Math.min(min, step.stepIndex), null);
    if (restartIndex == null)
        return;
    const timestamp = now();
    for (const step of sequence.steps.filter(item => item.stepIndex >= restartIndex)) {
        db.update(schema.videoSequenceSteps).set({
            status: 'pending',
            videoGenerationId: null,
            firstFrameLocalPath: null,
            firstFrameUrl: null,
            firstFrameAssetId: null,
            firstFrameAssetUri: null,
            tailFrameLocalPath: null,
            tailFrameUrl: null,
            tailFrameAssetId: null,
            tailFrameAssetUri: null,
            assetIds: null,
            assetRefs: null,
            referenceImageUrls: null,
            prompt: null,
            errorMsg: null,
            completedAt: null,
            updatedAt: timestamp,
        }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    }
    db.update(schema.videoSequenceRuns).set({
        status: 'queued',
        currentIndex: restartIndex,
        currentStoryboardId: sequence.steps.find(item => item.stepIndex === restartIndex)?.storyboardId || null,
        updatedAt: timestamp,
    }).where(eq(schema.videoSequenceRuns.id, sequence.id)).run();
    logTaskProgress('VideoSequence', 'stale-steps-reset', { runId: sequence.id, restartIndex });
}
async function processStep(sequence, step) {
    if (!sequence)
        return;
    const storyboard = getStoryboard(step.storyboardId);
    const previous = step.stepIndex > 0 ? sequence.steps.find(item => item.stepIndex === step.stepIndex - 1) || null : null;
    const normalizedProvider = String(sequence.provider || '').toLowerCase();
    const isGrokOpenAI = normalizedProvider === 'grok_openai';
    const isAutoDl = normalizedProvider === 'autodl_comfyui';
    const isComfyUi = normalizedProvider === 'comfyui';
    const isLatentPlus = isComfyUi && normalizeContinuityMode(sequence.continuityMode, normalizedProvider) === LOCAL_LATENT_PLUS;
    // Plus has no PNG first-frame input. Keep the legacy local path empty so
    // stale tail values cannot leak into a latent-only run or its UI record.
    // Local H3 has no provider first-frame input in either mode. Continuity is
    // carried only by Picture 1 (standard R2V) or the AV latent (Plus).
    const firstFrameLocalPath = null;
    if (!storyboard)
        throw new Error(`镜头 ${step.storyboardNumber || step.storyboardId} 不存在`);
    db.update(schema.videoSequenceSteps).set({ status: 'preparing', errorMsg: null, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    db.update(schema.videoSequenceRuns).set({ currentIndex: step.stepIndex, currentStoryboardId: step.storyboardId, updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, sequence.id)).run();
    if (step.videoGenerationId) {
        const reusedGeneration = getVideoGeneration(step.videoGenerationId);
        const reusable = reusedGeneration?.status === 'completed'
            && !reusedGeneration.deletedAt
            && isGenerationCompatibleWithStoryboard(reusedGeneration, storyboard, sequence.provider, sequence.continuityMode);
        if (reusable) {
            await finalizeSequenceStepVideo(sequence, { ...step, firstFrameLocalPath }, storyboard, reusedGeneration);
            logTaskProgress('VideoSequence', 'existing-video-reused', {
                runId: sequence.id,
                storyboardId: storyboard.id,
                stepIndex: step.stepIndex,
                videoGenerationId: reusedGeneration.id,
            });
            return;
        }
        if (reusedGeneration?.status === 'completed' && !reusedGeneration.deletedAt) {
            // A re-decomposed shot can still point at a completed row from an
            // older character whitelist or an older continuity mode.  Keep the
            // historical row intact for audit, but detach it from this run so
            // the current R2V/Plus request is submitted with fresh bindings.
            db.update(schema.videoSequenceSteps)
                .set({ videoGenerationId: null, assetIds: null, assetRefs: null, referenceImageUrls: null, prompt: null, updatedAt: now() })
                .where(eq(schema.videoSequenceSteps.id, step.id))
                .run();
            logTaskWarn('VideoSequence', 'stale-generation-detached', {
                runId: sequence.id,
                storyboardId: storyboard.id,
                stepIndex: step.stepIndex,
                videoGenerationId: reusedGeneration.id,
            });
        }
    }
    if (isLatentPlus && previous) {
        const config = sequence.configId ? getConfigById(Number(sequence.configId)) : null;
        const previousClipIndex = Number(previous.latentClipIndex || previous.stepIndex + 1);
        if (!previous.latentPath || !latentSlotExistsForPath(previous.latentPath, previousClipIndex, config)) {
            throw new Error(`H3 Motion Context Plus 缺少上一镜头 latent（clip_${String(previousClipIndex).padStart(5, '0')}.safetensors），已阻止提交镜头${storyboard.storyboardNumber}；请重新生成上一镜头或从头启动 Plus`);
        }
    }
    const refs = isGrokOpenAI
        ? await buildGrokStepReferences(storyboard, previous)
        : isComfyUi
            ? await buildComfyUiStepReferences(storyboard, previous, isLatentPlus)
            : isAutoDl
                ? await buildAutoDlStepReferences(storyboard, previous)
                : await buildStepReferences(storyboard, previous);
    if (isComfyUi) {
        assertLocalH3CharacterReferenceBindings(refs, getStoryboardContext(storyboard), storyboard.storyboardNumber);
    }
    assertLocalSequenceR2VContract(normalizedProvider, sequence.continuityMode, refs);
    validateSerialReferenceSlots(refs, {
        localR2v: isComfyUi,
        hasFirstFrame: !isLatentPlus && refs.some(item => isComfyUi
            ? isLocalContinuityReferenceRole(item.role)
            : isContinuityReferenceRole(item.role)),
        maxImages: isGrokOpenAI ? 7 : MAX_ASSETS,
        storyboardNumber: storyboard.storyboardNumber,
    });
    assertSequenceActive(sequence.id);
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sequence.episodeId)).all();
    const previousCharacterNames = isComfyUi ? sequenceStepCharacterNames(previous) : [];
    // Keep the two local H3 continuity channels explicit.  Standard R2V may
    // carry the previous rendered image as an ordinary Picture 1; Motion
    // Context Plus carries only the previous AV latent.  Do not pass a
    // generic `hasFirstFrame` flag into the local prompt builder, because that
    // makes a latent continuation look like a provider first-frame request in
    // stale branches and in persisted snapshots.
    const hasVideoContinuity = isComfyUi && !isLatentPlus && step.stepIndex > 0;
    const hasLatentContinuity = isComfyUi && isLatentPlus && step.stepIndex > 0;
    const hasLocalContinuity = hasLatentContinuity || hasVideoContinuity;
    const prompt = isGrokOpenAI
        ? buildGrokSequencePrompt(String(storyboard.videoPrompt || ''), refs, step.stepIndex > 0, episode?.breakdownMode, storyboard.dialogue, storyboard.movement)
        : isComfyUi
            ? buildComfyUiSequencePrompt(String(storyboard.videoPrompt || ''), refs, hasLocalContinuity, episode?.breakdownMode, storyboard.dialogue, storyboard.movement, previousCharacterNames, isLatentPlus, buildCharacterVoiceBindings(getStoryboardContext(storyboard).characters, episode?.scriptContent || episode?.content || ''), episode?.scriptContent || episode?.content || '')
            : isAutoDl
                ? buildAutoDlSequencePrompt(String(storyboard.videoPrompt || ''), refs, step.stepIndex > 0, episode?.breakdownMode, storyboard.dialogue, storyboard.movement)
            : buildSequencePrompt(String(storyboard.videoPrompt || ''), refs, step.stepIndex > 0, episode?.breakdownMode, storyboard.dialogue, storyboard.movement);
    const referenceUrls = refs.map(item => item.url);
    const referenceAssetUris = isGrokOpenAI || isAutoDl
        ? refs.map(item => item.url)
        : isComfyUi
            ? refs.map(item => item.url)
            : refs.map(item => formatSequenceAssetUri(item.asset));
    const assetIds = refs.map(item => item.asset?.providerAssetId).filter(Boolean);
    // Persist the complete semantic binding, not only a display label. A
    // later retry/re-decomposition must be able to prove that Picture N still
    // points at the same database entity; names alone are ambiguous when two
    // characters have aliases or translated labels that overlap.
    const assetBindings = refs.map(item => ({
        name: item.name,
        entity_name: item.entityName || null,
        canonical_name: item.entityName || null,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        entity_id: Number(item.entityId || 0) || null,
        role: item.role,
        category: item.category,
        asset_id: item.asset?.providerAssetId,
        asset_uri: item.asset?.assetUri,
        url: item.url,
    }));
    // Local MiniMax H3 is R2V-only. Keep the mode and image channel explicit
    // at the point where the generation record is created so a stale branch
    // cannot accidentally turn a serial shot into first_frame_multiple/I2V.
    const generationReferenceMode = isComfyUi || isAutoDl
        ? 'multiple'
        : (step.stepIndex > 0 ? 'first_frame_multiple' : (referenceUrls.length ? 'multiple' : 'none'));
    // Local MiniMax H3 always uses the ordered R2V image list.  A stale
    // previous-tail value must never be persisted as a provider first-frame
    // field, even for the standard local mode.
    const generationFirstFrameUrl = isComfyUi || isAutoDl ? undefined : (previous ? referenceAssetUris[0] : undefined);
    db.update(schema.videoSequenceSteps).set({
        status: 'submitting',
        prompt,
        assetIds: JSON.stringify(assetIds),
        assetRefs: JSON.stringify(assetBindings),
        referenceImageUrls: JSON.stringify(referenceAssetUris),
        firstFrameLocalPath,
        // Keep the continuity frame only in refs[0]/Picture 1. It is not a
        // provider first-frame parameter for local R2V.
        firstFrameUrl: null,
        firstFrameAssetId: null,
        firstFrameAssetUri: null,
        updatedAt: now(),
    }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    let generationId = step.videoGenerationId || null;
    if (generationId) {
        const existingGeneration = getVideoGeneration(generationId);
        if (!existingGeneration || existingGeneration.deletedAt)
            generationId = null;
    }
    if (!generationId) {
        assertSequenceActive(sequence.id);
        generationId = await generateVideo({
            storyboardId: storyboard.id,
            dramaId: sequence.dramaId,
            prompt,
            promptIsFinal: true,
            model: sequence.model || undefined,
            referenceMode: generationReferenceMode,
            // R2V has no first_frame group input. The local path carries the
            // previous tail only in referenceImageUrls[0] (Picture 1), and
            // never in firstFrameUrl/lastFrameUrl.
            firstFrameUrl: generationFirstFrameUrl,
            referenceImageUrls: isComfyUi || isAutoDl
                ? referenceUrls.slice(0, MAX_ASSETS)
                : isContinuityReferenceRole(refs[0]?.role)
                    ? referenceAssetUris.slice(1, isGrokOpenAI ? 7 : 9)
                    : referenceAssetUris.slice(0, isGrokOpenAI ? 7 : 9),
            referenceVideoLocalPath: isComfyUi && !isLatentPlus && previous
                ? (() => {
                    const previousGeneration = getVideoGeneration(previous.videoGenerationId || 0);
                    return previousGeneration?.localPath || previousGeneration?.videoUrl || null;
                })()
                : null,
            duration: storyboard.duration || 5,
            aspectRatio: sequence.aspectRatio || undefined,
            megapixels: sequence.megapixels || undefined,
            steps: sequence.samplingSteps || undefined,
            loraStrength: sequence.loraStrength ?? undefined,
            configId: sequence.configId || undefined,
            sequenceRunId: sequence.id,
            sequenceStepIndex: step.stepIndex,
            continuityMode: isLatentPlus ? LOCAL_LATENT_PLUS : STANDARD_R2V,
            latentPath: isLatentPlus ? (step.latentPath || latentDirectoryForRun(sequence.id)) : null,
            latentClipIndex: isLatentPlus ? (step.latentClipIndex || step.stepIndex + 1) : null,
        });
        db.update(schema.videoSequenceSteps).set({ status: 'processing', videoGenerationId: generationId, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    }
    else {
        db.update(schema.videoSequenceSteps).set({ status: 'processing', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    }
    await waitForVideoGeneration(generationId, sequence.id);
    const completed = getVideoGeneration(generationId);
    if (!completed || completed.status !== 'completed')
        throw new Error(completed?.errorMsg || '串行视频生成失败');
    if (isLatentPlus) {
        const config = sequence.configId ? getConfigById(Number(sequence.configId)) : null;
        const clipIndex = Number(step.latentClipIndex || step.stepIndex + 1);
        if (!(await waitForLatentSlot(step.latentPath, clipIndex, config))) {
            throw new Error(`H3 Motion Context Plus 已收到视频但未找到 latent 文件（clip_${String(clipIndex).padStart(5, '0')}.safetensors），已阻止继续串联`);
        }
    }
    await finalizeSequenceStepVideo(sequence, { ...step, firstFrameLocalPath }, storyboard, completed);
    logTaskProgress('VideoSequence', 'step-completed', { runId: sequence.id, storyboardId: storyboard.id, stepIndex: step.stepIndex, assetCount: assetIds.length });
}
async function waitForLatentSlot(latentPath, clipIndex, config, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (latentSlotExistsForPath(latentPath, clipIndex, config)) return true;
        await sleep(500);
    }
    return latentSlotExistsForPath(latentPath, clipIndex, config);
}
export function shouldExtractSequenceTail(provider, continuityMode) {
    // Local MiniMax H3 never exposes a tail-frame phase.  Standard R2V still
    // prepares one ordinary continuity picture internally, but that work is
    // represented by the neutral continuity-reference fields below.  Motion
    // Context Plus carries continuity in AV latent and needs no picture.
    return String(provider || '').trim().toLowerCase() !== 'comfyui';
}
export function shouldPrepareLocalContinuityReference(provider, continuityMode) {
    // Standard R2V receives the complete previous video directly. Do not
    // extract a tail still that can compete with current-shot Picture assets.
    return false;
}

/**
 * Local MiniMax H3 is never allowed to enter the retired first/last-frame
 * pipeline. This helper is intentionally provider-only (independent from the
 * selected serial continuity mode) so both standard R2V and Motion Context
 * Plus share one hard boundary.
 */
export function isLocalMiniMaxH3Provider(provider) {
    return String(provider || '').trim().toLowerCase() === 'comfyui';
}

/**
 * Legacy local-H3 sequence rows may have been created before R2V isolation
 * was enabled.  They are unsafe to resume even when the database columns say
 * `multiple`: their snapshot can still contain first/tail-frame wording or
 * bindings.  Keep the check centralized so startup reconciliation and the
 * public episode lookup apply the same rule.
 */
export function isLegacyLocalH3SequenceStep(step) {
    if (!step) return false;
    const status = String(step.status || '').trim().toLowerCase();
    if (status === 'extracting_tail') return true;
    const refs = step.assetRefs ?? step.asset_refs;
    if (refs != null) {
        try {
            const parsed = Array.isArray(refs) ? refs : JSON.parse(String(refs || '[]'));
            if (Array.isArray(parsed) && parsed.some(item => ['first_frame', 'last_frame', CONTINUITY_REFERENCE_ROLE].includes(String(item?.role || '').trim().toLowerCase()))) return true;
        } catch { /* malformed legacy snapshot is handled by prompt/fields below */ }
    }
    return !!(
        String(step.firstFrameLocalPath || step.first_frame_local_path || step.firstFrameUrl || step.first_frame_url || '').trim()
        || String(step.tailFrameLocalPath || step.tail_frame_local_path || step.tailFrameUrl || step.tail_frame_url || '').trim()
        || hasLegacyLocalH3FrameSemantics(step.prompt || step.finalPrompt || step.final_prompt || '')
    );
}

/**
 * A local H3 step is valid only when its persisted reference snapshot is the
 * R2V image list.  This is deliberately stricter than the display sanitizer:
 * a legacy row must not be allowed to seed a newly-created run, even if its
 * frame columns were cleared on the API response.
 */
export function isLocalH3R2VStep(step) {
    if (!step) return false;
    if (isLegacyLocalH3SequenceStep(step)) return false;
    const refs = step.assetRefs ?? step.asset_refs;
    if (refs != null) {
        try {
            const parsed = Array.isArray(refs) ? refs : JSON.parse(String(refs || '[]'));
            if (Array.isArray(parsed) && parsed.some(item => ['first_frame', 'last_frame', CONTINUITY_REFERENCE_ROLE].includes(String(item?.role || '').trim().toLowerCase()))) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export function isLegacyLocalH3SequenceRun(run, steps = []) {
    if (String(run?.provider || '').trim().toLowerCase() !== 'comfyui') return false;
    const mode = normalizeContinuityMode(run?.continuityMode || run?.continuity_mode, run.provider);
    // Both local modes are R2V-only; a step-level legacy marker is enough to
    // invalidate the whole snapshot.  This also catches standard-R2V rows
    // that were later reopened as Motion Context Plus.
    return (steps || []).some(step => isLegacyLocalH3SequenceStep(step))
        || (mode === LOCAL_LATENT_PLUS && (steps || []).some(step => String(step?.continuityReferenceLocalPath || step?.continuity_reference_local_path || step?.continuityReferenceUrl || step?.continuity_reference_url || '').trim()));
}
export function shouldUploadSequenceTail(provider) {
    // Local ComfyUI consumes an ordinary local Picture reference.  It must not
    // be uploaded to Volc/Uguu and must never become a provider first/last
    // frame parameter.  Remote providers still need a public/asset reference.
    return String(provider || '').trim().toLowerCase() !== 'comfyui';
}
async function finalizeSequenceStepVideo(sequence, step, storyboard, completed) {
    const normalizedProvider = String(sequence.provider || '').toLowerCase();
    const isGrokSequence = normalizedProvider === 'grok_openai';
    const isLocalComfyUi = normalizedProvider === 'comfyui';
    const isLatentPlus = isLocalComfyUi && normalizeContinuityMode(sequence.continuityMode, normalizedProvider) === LOCAL_LATENT_PLUS;
    const prepareLocalContinuity = shouldPrepareLocalContinuityReference(normalizedProvider, sequence.continuityMode);
    const extractTail = shouldExtractSequenceTail(normalizedProvider, sequence.continuityMode);
    // Motion Context Plus carries continuity through the previous shot's AV
    // latent. It deliberately has no first/last-frame hand-off and must not
    // launch ffmpeg/upload work or expose an `extracting_tail` phase.
    if (!extractTail && !prepareLocalContinuity) {
        db.update(schema.videoSequenceSteps).set({
            status: 'completed',
            continuityReferenceLocalPath: null,
            continuityReferenceUrl: null,
            continuityReferenceAssetId: null,
            continuityReferenceAssetUri: null,
            tailFrameLocalPath: null,
            tailFrameUrl: null,
            tailFrameAssetId: null,
            tailFrameAssetUri: null,
            completedAt: now(),
            updatedAt: now(),
        }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
        return;
    }
    db.update(schema.videoSequenceSteps).set({ status: 'preparing', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    let videoSource = completed.localPath || completed.videoUrl || '';
    const continuity = isLocalComfyUi
        ? await extractContinuityReferenceImage(videoSource)
        : await extractTailFrame(videoSource);
    const localComfyUi = normalizedProvider === 'comfyui';
    const publicUrl = localComfyUi
        ? continuity.localPath
        : await uploadTailFrame(continuity.localPath, storyboard, sequence, isGrokSequence, false);
    const asset = localComfyUi || isGrokSequence
        ? null
        : await syncVolcImageAsset({
            url: publicUrl,
            name: `镜头${storyboard.storyboardNumber}-连续参考图`,
            category: 'storyboard',
            dramaId: sequence.dramaId,
            episodeId: sequence.episodeId,
            storyboardId: storyboard.id,
            storyboardNum: storyboard.storyboardNumber,
            source: 'volc:videoSequenceTailFrame',
        });
    db.update(schema.videoSequenceSteps).set({
        status: 'completed',
        continuityReferenceLocalPath: localComfyUi ? continuity.localPath : null,
        continuityReferenceUrl: localComfyUi ? publicUrl : null,
        continuityReferenceAssetId: localComfyUi ? null : asset?.providerAssetId || null,
        continuityReferenceAssetUri: localComfyUi ? null : asset?.assetUri || asset?.providerAssetId || null,
        // Keep legacy remote rows working, but local H3 never writes these
        // provider frame columns.
        tailFrameLocalPath: localComfyUi ? null : continuity.localPath,
        tailFrameUrl: localComfyUi ? null : publicUrl,
        tailFrameAssetId: localComfyUi ? null : asset?.providerAssetId || null,
        tailFrameAssetUri: localComfyUi ? null : asset?.assetUri || asset?.providerAssetId || null,
        completedAt: now(),
        updatedAt: now(),
    }).where(eq(schema.videoSequenceSteps.id, step.id)).run();
    // Remote providers retain their historical storyboard tail image for
    // compatibility. Local H3 continuity stays inside the sequence snapshot
    // and must not reappear as a first/last-frame storyboard asset.
    if (!localComfyUi)
        db.update(schema.storyboards).set({ lastFrameImage: continuity.localPath, updatedAt: now() }).where(eq(schema.storyboards.id, storyboard.id)).run();
}
async function buildStepReferences(storyboard, previous) {
    const refs = [];
    const seenUrls = new Set();
    const seenAssets = new Set();
    const push = (item) => {
        const url = String(item.url || '').trim();
        const sourceKey = referenceSourceKey(url);
        const assetId = String(item.asset?.providerAssetId || '').trim();
        if (!url || (sourceKey && seenUrls.has(sourceKey)) || (assetId && seenAssets.has(assetId)))
            return;
        if (sourceKey)
            seenUrls.add(sourceKey);
        if (assetId)
            seenAssets.add(assetId);
        refs.push({ ...item, url });
    };
    const previousContinuityUrl = continuityReferenceUrlFromStep(previous);
    if (previousContinuityUrl) {
        push({
            url: previousContinuityUrl,
            name: '连续参考图',
            role: 'continuity_reference',
            category: 'storyboard',
            asset: {
                localAssetId: 0,
                providerAssetId: previous.continuityReferenceAssetId || previous.continuity_reference_asset_id,
                assetUri: previous.continuityReferenceAssetUri || previous.continuity_reference_asset_uri,
            },
            groupName: 'Eggfans-串行连续参考',
                publicUrl: previousContinuityUrl,
        });
    }
    else if (previous) {
        throw new Error(`上一镜头连续参考图未准备完成，无法生成镜头${storyboard.storyboardNumber}`);
    }
    const context = getStoryboardContext(storyboard);
    if (context.episodeSceneCount > 0 && !context.scene) {
        throw new Error(`镜头${storyboard.storyboardNumber}未找到当前集场景资产，已阻止无场景视频；请检查 location/scene_id 是否属于当前集场景列表`);
    }
    // Include a user-generated first frame on the first serial shot and sync it
    // to Volc so it is passed as Asset:// just like continuity frames.
    if (!previous && storyboard.firstFrameImage) {
        const asset = await syncVolcImageAsset({
            url: storyboard.firstFrameImage,
            name: `镜头${storyboard.storyboardNumber}-首帧`,
            category: 'storyboard',
            dramaId: context.dramaId,
            episodeId: context.episodeId,
            storyboardId: storyboard.id,
            storyboardNum: storyboard.storyboardNumber,
            source: 'volc:videoSequenceFirstFrame',
        });
        push({ url: asset.publicUrl || storyboard.firstFrameImage, name: '开场参考图', role: 'reference_image', category: 'storyboard', asset });
    }
    const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character));
    if (missingCharacters.length)
        throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`);
    if (context.scene && !getEntityImageUrl(context.scene))
        throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`);
    const missingProps = context.props.filter(prop => !getEntityImageUrl(prop));
    if (missingProps.length)
        throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`);
    const requiredSources = [
        ...(context.scene ? [{ name: `场景-${context.scene.location}`, url: getEntityImageUrl(context.scene) }] : []),
        ...context.characters.map(character => ({ name: `角色-${character.name}`, url: getEntityImageUrl(character) })),
        ...context.props.map(prop => ({ name: `道具-${prop.name}`, url: getEntityImageUrl(prop) })),
    ];
    const requiredUrls = new Set(seenUrls);
    for (const item of requiredSources) {
        const key = referenceSourceKey(item.url);
        if (key)
            requiredUrls.add(key);
    }
    if (requiredUrls.size > MAX_ASSETS) {
        const firstFrameCount = previous || (!previous && !!storyboard.firstFrameImage) ? 1 : 0;
        throw new Error(`镜头${storyboard.storyboardNumber}必须参考 ${requiredUrls.size} 个资产（首帧${firstFrameCount}、角色${context.characters.length}、场景${context.scene ? 1 : 0}、道具${context.props.length}），超过谜镜 9 个资产上限，请减少本镜头角色或道具后重试`);
    }
    if (context.scene) {
        const sceneImageUrl = getEntityImageUrl(context.scene);
        const asset = await syncVolcImageAsset({ url: sceneImageUrl, name: `场景-${context.scene.location}`, category: 'scene', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceScene' });
        push({ url: asset.publicUrl || sceneImageUrl, name: `场景-${context.scene.location}`, role: 'scene', category: 'scene', entityName: context.scene.location, asset });
    }
    for (const character of context.characters) {
        const asset = await syncVolcCharacterAssetForCharacter(character.id);
        push({ url: asset.publicUrl || getEntityImageUrl(character), name: `角色-${character.name}`, role: 'character', category: 'character', entityName: character.name, characterId: character.id, asset });
    }
    for (const prop of context.props) {
        const propImageUrl = getEntityImageUrl(prop);
        const asset = await syncVolcImageAsset({ url: propImageUrl, name: `道具-${prop.name}`, category: 'prop', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceProp' });
        push({ url: asset.publicUrl || propImageUrl, name: `道具-${prop.name}`, role: 'prop', category: 'prop', entityName: prop.name, asset });
    }
    const manualRefs = parseReferenceImages(storyboard.referenceImages);
    let skippedManualRefs = 0;
    for (const [index, url] of manualRefs.entries()) {
        if (refs.length >= MAX_ASSETS) {
            skippedManualRefs = manualRefs.length - index;
            break;
        }
        const asset = await syncVolcImageAsset({ url, name: `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, category: 'storyboard', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceReference' });
        push({ url: asset.publicUrl || url, name: `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, role: 'reference_image', category: 'storyboard', asset });
    }
    if (skippedManualRefs) {
        logTaskWarn('VideoSequence', 'optional-references-truncated', {
            storyboardId: storyboard.id,
            storyboardNumber: storyboard.storyboardNumber,
            skippedManualRefs,
            maxAssets: MAX_ASSETS,
        });
    }
    const ordered = orderSerialReferenceAssets(refs);
    const continuityReference = ordered.find(item => isContinuityReferenceRole(item.role));
    const sceneRefs = ordered.filter(item => String(item.role || '').trim().toLowerCase() === 'scene');
    const sceneAlreadyIsOpeningFrame = context.scene
        ? referenceSourceKey(getEntityImageUrl(context.scene)) === referenceSourceKey(continuityReference?.url)
        : false;
    if (context.scene && sceneRefs.length === 0 && !sceneAlreadyIsOpeningFrame) {
        throw new Error(`镜头${storyboard.storyboardNumber}已解析到场景“${context.scene.location}”，但场景图未进入参考列表；已阻止生成白底视频`);
    }
    if (previous && (!continuityReference || ordered[0] !== continuityReference)) {
        throw new Error(`镜头${storyboard.storyboardNumber}连续参考图未占用 Picture 1，已阻止错误串联`);
    }
    validateSerialReferenceSlots(ordered, {
        hasFirstFrame: ordered.some(item => isContinuityReferenceRole(item.role)),
        maxImages: MAX_ASSETS,
        storyboardNumber: storyboard.storyboardNumber,
    });
    return ordered;
}
async function buildGrokStepReferences(storyboard, previous) {
    const refs = [];
    const seen = new Set();
    const push = (url, name, role, category, entityName) => {
        const value = String(url || '').trim();
        if (!value || seen.has(value))
            return;
        seen.add(value);
        refs.push({ url: value, name, role, category, entityName });
    };
    if (previous) {
        const continuityUrl = continuityReferenceUrlFromStep(previous);
        if (!continuityUrl)
            throw new Error(`上一镜头连续参考图未准备完成，无法生成镜头${storyboard.storyboardNumber}`);
        push(continuityUrl, '连续参考图', CONTINUITY_REFERENCE_ROLE, 'storyboard');
    }
    const context = getStoryboardContext(storyboard);
    if (context.episodeSceneCount > 0 && !context.scene) {
        throw new Error(`镜头${storyboard.storyboardNumber}未找到当前集场景资产，已阻止无场景视频；请检查 location/scene_id 是否属于当前集场景列表`);
    }
    const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character));
    if (missingCharacters.length)
        throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`);
    if (context.scene && !getEntityImageUrl(context.scene))
        throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`);
    const missingProps = context.props.filter(prop => !getEntityImageUrl(prop));
    if (missingProps.length)
        throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`);
    if (context.scene)
        push(getEntityImageUrl(context.scene), `场景-${context.scene.location}`, 'scene', 'scene', context.scene.location);
    context.characters.forEach(character => push(getEntityImageUrl(character), `角色-${character.name}`, 'character', 'character', character.name));
    context.props.forEach(prop => push(getEntityImageUrl(prop), `道具-${prop.name}`, 'prop', 'prop', prop.name));
    parseReferenceImages(storyboard.referenceImages).forEach((url, index) => push(url, `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, 'reference_image', 'storyboard'));
    if (refs.length > 7) {
        throw new Error(`镜头${storyboard.storyboardNumber}需要 ${refs.length} 张 Grok Imagine 参考图，超过最多 7 张限制；请减少角色、道具或镜头参考图`);
    }
    return orderSerialReferenceAssets(refs);
}
/** Build AutoDL references without touching the local ComfyUI resolver. The
 * hosted workflow receives public URLs later in the AutoDL adapter; here we
 * only resolve the current storyboard's semantic asset set and preserve the
 * previous shot's continuity image as the first ordered reference. */
async function buildAutoDlStepReferences(storyboard, previous) {
    const refs = [];
    const seen = new Set();
    const push = (url, name, role, category, entityName) => {
        const value = String(url || '').trim();
        const key = referenceSourceKey(value);
        if (!value || !key || seen.has(key))
            return;
        seen.add(key);
        refs.push({ url: value, name, role, category, entityName });
    };
    if (previous) {
        const continuityUrl = continuityReferenceUrlFromStep(previous);
        if (!continuityUrl)
            throw new Error(`上一镜头连续参考图未准备完成，无法生成镜头${storyboard.storyboardNumber}`);
        push(continuityUrl, '连续参考图', CONTINUITY_REFERENCE_ROLE, 'storyboard');
    }
    const context = getStoryboardContext(storyboard);
    if (context.episodeSceneCount > 0 && !context.scene)
        throw new Error(`镜头${storyboard.storyboardNumber}未找到当前集场景资产，已阻止无场景视频`);
    const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character));
    if (missingCharacters.length)
        throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`);
    if (context.scene && !getEntityImageUrl(context.scene))
        throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`);
    const missingProps = context.props.filter(prop => !getEntityImageUrl(prop));
    if (missingProps.length)
        throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`);
    if (context.scene)
        push(getEntityImageUrl(context.scene), `场景-${context.scene.location}`, 'scene', 'scene', context.scene.location);
    orderStoryboardCharacters(context.characters, storyboard).forEach(character => {
        push(getEntityImageUrl(character), `角色-${character.name}`, 'character', 'character', character.name);
    });
    rankStoryboardProps(filterCharacterOwnedWardrobeProps(context.props, context.characters), storyboard)
        .slice(0, Math.max(0, MAX_ASSETS - refs.length))
        .forEach(prop => push(getEntityImageUrl(prop), `道具-${prop.name}`, 'prop', 'prop', prop.name));
    parseReferenceImages(storyboard.referenceImages).forEach((url, index) => {
        if (refs.length < MAX_ASSETS)
            push(url, `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, 'reference_image', 'storyboard');
    });
    if (refs.length > MAX_ASSETS)
        throw new Error(`镜头${storyboard.storyboardNumber}需要 ${refs.length} 张 AutoDL 参考图，超过最多 ${MAX_ASSETS} 张限制`);
    const ordered = orderSerialReferenceAssets(refs);
    if (previous && (!ordered.length || !isContinuityReferenceRole(ordered[0].role)))
        throw new Error(`镜头${storyboard.storyboardNumber}连续参考图未占用第一张 AutoDL 参考图`);
    return ordered;
}
function buildAutoDlSequencePrompt(original, refs, hasContinuity, breakdownMode, dialogue, movement) {
    const bindings = refs.map((item, index) => {
        const label = String(item.entityName || item.name || `参考图${index + 1}`).replace(/^角色-|^场景-|^道具-/, '').trim();
        return `<Picture ${index + 1}> = ${label} (${String(item.role || 'reference')})`;
    }).join('; ');
    const continuity = hasContinuity
        ? '第一张参考图是上一镜头的连续构图图片，必须作为本镜头开场状态严格承接；其余图片只用于各自映射的角色、场景和道具外观。'
        : '这是串行生成的第一个镜头，只使用各自映射的参考图片建立人物、场景和道具。';
    const prompt = [
        `AutoDL ComfyUI 有序多参考图绑定（共 ${refs.length} 张）：${bindings}`,
        continuity,
        '严格保持每张图片与其绑定角色、场景或道具的一一对应，不得交换、合并、替换或凭空添加身份；场景图片是背景环境唯一依据，禁止白底。',
        '对白必须由标注的角色本人说出，保持原台词、语气和语速；只生成当前一个分镜。',
        appendCameraMotionInstruction(stripSequencePrompt(String(original || '').trim()), movement),
    ].filter(Boolean).join('\n');
    return withTkOverseasVisualLock(appendVideoDialoguePrompt(prompt, dialogue, breakdownMode), breakdownMode, 'AutoDL MiniMax H3 串行视频生成');
}
/** Build references for local ComfyUI. Keep the actual local/public image URL
 * because the ComfyUI adapter uploads it to /upload/image; never require a
 * Volc Asset URI for this provider. */
async function buildComfyUiStepReferences(storyboard, previous, latentPlus = false) {
    const refs = [];
    const seen = new Set();
    const push = (url, name, role, category, entityName, primary = false, identityDescription, aliases = [], entityId = null, storyRole = '') => {
        const value = String(url || '').trim();
        const sourceKey = referenceSourceKey(value);
        if (!value || !sourceKey || seen.has(sourceKey))
            return;
        seen.add(sourceKey);
        refs.push({ url: value, name, role, category, entityName, primary, identityDescription, aliases, entityId, storyRole });
    };
    // Standard local H3 continuity is carried by the previous complete video
    // through Video 1. Current Picture assets belong only to this shot.
    // Local MiniMax H3 is always an asset-list R2V request.  Do not inject the
    // storyboard's generated `firstFrameImage` into the first shot: that image
    // is a composite/legacy frame snapshot and can carry a different actor or
    // pose, causing the model to replace the explicitly mapped protagonist.
    // The opening shot is fully defined by the ordered character, scene and
    // prop assets below. A follow-up shot gets the previous continuity image
    // first (standard R2V); Plus uses AV latent and must not receive it.
    const context = getStoryboardContext(storyboard);
    if (context.episodeSceneCount > 0 && !context.scene) {
        throw new Error(`镜头${storyboard.storyboardNumber}未找到当前集场景资产，已阻止无场景视频；请检查 location/scene_id 是否属于当前集场景列表`);
    }
    const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character));
    if (missingCharacters.length)
        throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`);
    if (context.scene && !getEntityImageUrl(context.scene))
        throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`);
    if (context.scene)
        push(getEntityImageUrl(context.scene), `场景-${context.scene.location}`, 'scene', 'scene', context.scene.location, false, undefined, entityBindingNames(context.scene, context.scene.location), context.scene.id);
    // Keep character Picture slots in the same order as the explicit role tags
    // in this shot.  The H3 R2V node receives an ordered image list and can
    // otherwise associate two visually similar people by their list position
    // even though the prose mapping is correct.  This was observable when a
    // shot tagged 姜师姐 before 七长老 still sent the database/id order (七长老
    // before 姜师姐), causing the two identities to swap in generated frames.
    const orderedCharacters = orderStoryboardCharacters(context.characters, storyboard);
    const wardrobeOwners = context.characters
        .flatMap(character => characterOwnedPropNames(character, context.props)
            .map(propName => ({ character, propName })));
    orderedCharacters.forEach(character => {
        const ownedWardrobeNames = wardrobeOwners
            .filter(item => item.character.id === character.id)
            .map(item => item.propName);
        const foreignWardrobeLocks = wardrobeOwners
            .filter(item => item.character.id !== character.id)
            .map(item => `${item.propName} belongs only to ${item.character.name}`);
        const baseIdentity = characterIdentityDescriptionWithAliases(character, context.allCharacterNames);
        const wardrobeRules = [
            ownedWardrobeNames.length
                ? `WARDROBE STORY-PROP NOTICE: ${ownedWardrobeNames.join(', ')} is a screenplay wardrobe prop associated with ${character.name}, not a replacement identity source. If the prop is explicitly visible, keep it separate from the character identity; the linked character Picture remains the sole authority for ${character.name}'s actual clothing, colors and visible wear.`
                : '',
            foreignWardrobeLocks.length
                ? `WARDROBE EXCLUSION LOCK: ${foreignWardrobeLocks.join('; ')}. ${character.name} must never wear, inherit or resemble those garments, colors or blood/wear patterns.`
                : '',
        ].filter(Boolean).join(' ');
        const identityDescription = [baseIdentity, wardrobeRules].filter(Boolean).join(' ');
        push(getEntityImageUrl(character), `角色-${character.name}`, 'character', 'character', character.name, isPrimaryCharacter(character), identityDescription, characterBindingNames(character), character.id, character.role || '');
    });
    // MiniMax H3 accepts at most nine local reference images.  The previous
    // tail frame is always first; exact character and scene identities are
    // mandatory, while props and hand-added images are optional.  Selecting
    // props by narrative relevance prevents a full shot from failing merely
    // because the screenplay mentions several overlapping table objects.
    const propBudget = Math.max(0, MAX_ASSETS - refs.length);
    // A wardrobe image whose name/description identifies an active character
    // is already represented by that character's portrait.  Do not send it as
    // another R2V picture: a second picture of the same outfit is interpreted
    // by H3 as a competing identity and can dress the protagonist as another
    // role (the observed Fengxi/Bai Ling swap).  Keep all non-costume props
    // and their normal relevance ranking unchanged.
    const characterOwnedProps = context.props.filter(prop => context.characters.some(character => isCharacterOwnedProp(prop, character)));
    const filteredProps = filterCharacterOwnedWardrobeProps(context.props, context.characters);
    const rankedProps = rankStoryboardProps(filteredProps, storyboard);
    if (characterOwnedProps.length) {
        logTaskWarn('VideoSequence', 'character-owned-wardrobe-reference-suppressed', {
            storyboardId: storyboard.id,
            storyboardNumber: storyboard.storyboardNumber,
            suppressedProps: characterOwnedProps.map(prop => prop.name),
            reason: 'wardrobe is bound to the owning character portrait and must not compete as an independent R2V identity',
        });
    }
    const selectedProps = rankedProps.slice(0, propBudget);
    const missingProps = selectedProps.filter(prop => !getEntityImageUrl(prop));
    if (missingProps.length)
        throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`);
    for (const prop of selectedProps) {
        push(getEntityImageUrl(prop), `道具-${prop.name}`, 'prop', 'prop', prop.name, false, undefined, entityBindingNames(prop, prop.name), prop.id);
    }
    const skippedProps = Math.max(0, rankedProps.length - selectedProps.length);
    if (skippedProps) {
        logTaskWarn('VideoSequence', 'optional-props-truncated', {
            storyboardId: storyboard.id,
            storyboardNumber: storyboard.storyboardNumber,
            skippedProps,
            maxAssets: MAX_ASSETS,
            selectedProps: selectedProps.map(item => item.name),
        });
    }
    let skippedManualRefs = 0;
    for (const [index, url] of parseReferenceImages(storyboard.referenceImages).entries()) {
        if (refs.length >= MAX_ASSETS) {
            skippedManualRefs++;
            continue;
        }
        push(url, `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, 'reference_image', 'storyboard');
    }
    if (skippedManualRefs) {
        logTaskWarn('VideoSequence', 'optional-references-truncated', {
            storyboardId: storyboard.id,
            storyboardNumber: storyboard.storyboardNumber,
            skippedManualRefs,
            maxAssets: MAX_ASSETS,
        });
    }
    if (refs.length > MAX_ASSETS)
        throw new Error(`镜头${storyboard.storyboardNumber}需要 ${refs.length} 张本地 ComfyUI 参考图，超过最多 ${MAX_ASSETS} 张限制；请减少角色、场景、道具或镜头参考图`);
    const ordered = orderSerialReferenceAssets(refs);
    const sceneRefs = ordered.filter(item => String(item.role || '').trim().toLowerCase() === 'scene');
    if (context.scene && sceneRefs.length === 0) {
        throw new Error(`镜头${storyboard.storyboardNumber}已解析到场景“${context.scene.location}”，但场景图未进入参考列表；已阻止生成白底视频`);
    }
    validateSerialReferenceSlots(ordered, {
        localR2v: true,
        hasFirstFrame: false,
        maxImages: MAX_ASSETS,
        storyboardNumber: storyboard.storyboardNumber,
    });
    return ordered;
}
/**
 * Rank props for a single shot without treating a short name as a separate
 * asset when it only occurs inside a longer name (for example “啤酒” inside
 * “啤酒瓶”).  Action/video text gets priority over passive result or style
 * descriptions, so the prop that actually drives the shot is retained first.
 */
export function rankStoryboardProps(props, storyboard) {
    const actionText = stripVisualStyleLock(storyboard.action);
    const dialogueText = stripVisualStyleLock(storyboard.dialogue);
    const videoText = stripVisualStyleLock(storyboard.videoPrompt);
    const resultText = stripVisualStyleLock(storyboard.result);
    const imageText = stripVisualStyleLock(storyboard.imagePrompt);
    const descriptionText = stripVisualStyleLock(storyboard.description);
    const promptText = [videoText, resultText, imageText, descriptionText].join('\n');
    const allText = `${actionText}\n${dialogueText}\n${promptText}`;
    const normalizedAllText = normalizeEntityText(allText);
    return props
        .map((prop, index) => {
        const name = String(prop.name || '').trim();
        const normalizedName = normalizeEntityText(name);
        const terms = propBindingTerms(prop);
        // Count aliases as well as canonical names, while suppressing a generic
        // term when it is covered by a more specific asset (for example
        // "beer" inside "beer bottle").  This also handles the reverse case
        // where the model writes English but the asset name is Chinese.
        if (!normalizedName || !terms.length || propMentionCount(allText, prop, props) <= 0)
            return { prop, index, score: -1 };
        const actionHits = propMentionCount(`${actionText}\n${dialogueText}`, prop, props);
        const videoHits = propMentionCount(videoText, prop, props);
        const resultHits = propMentionCount(resultText, prop, props);
        const imageHits = propMentionCount(imageText, prop, props);
        const descriptionHits = propMentionCount(descriptionText, prop, props);
        // Prefer the specific asset variant (for example 啤酒瓶) when the
        // shorter name is only a passive description (啤酒).  Keep the shorter
        // asset only when the action text explicitly operates on it, because
        // that is a real distinct on-screen object rather than a substring hit.
        // Stable opening/end-state props are more useful for continuity than a
        // transient action prop (e.g. a belt in a chase).  Keep the weights
        // explicit so ranking remains deterministic and testable.
        const score = resultHits * 200 + videoHits * 50 + actionHits * 10 + imageHits * 5 + descriptionHits;
        return { prop, index, score };
    })
        .filter(item => item.score >= 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.prop);
}
function countEntityMentions(text, name) {
    const source = normalizeEntityText(text);
    const target = normalizeEntityText(name);
    if (!target)
        return 0;
    let count = 0;
    let offset = source.indexOf(target);
    while (offset >= 0) {
        count++;
        offset = source.indexOf(target, offset + target.length);
    }
    return count;
}
export function buildSequencePrompt(original, refs, hasFirstFrame, breakdownMode, dialogue, movement) {
    const bindings = refs.map(item => `${bindingLabel(item)}=${formatAsset(item.asset)} `).join('；');
    const sceneBindings = refs.filter(item => item.role === 'scene').map(item => bindingLabel(item)).filter(Boolean);
    const rules = hasFirstFrame
        ? '上一镜尾帧是本镜头视频第 0 帧（第一帧）的唯一画面真值；第 0 帧只复制这张连续性图片。角色、场景和道具参考图均从视频第 1 帧（第二帧）开始参与外观一致性，不能覆盖或改写第 0 帧；随后再按原分镜文本生成动作。不要重新设计，不要改变服装或人物关系。'
        : '这是串行生成的第一个镜头；角色、场景和道具只使用对应资产的外观，不要重新设计，不要改变服装或人物关系。';
    const prompt = [
        `连续镜头资产绑定：${bindings}`,
        sceneBindings.length ? `场景环境为必需参考：${sceneBindings.join('、')}。必须保留场景空间结构、光线和材质，禁止生成白底或替换场景；有上一镜尾帧时，场景参考只能从视频第 1 帧（第二帧）开始参与，不得覆盖视频第 0 帧的连续性画面。` : '',
        rules,
        '资产 ID 只在本段绑定中声明一次；对白中的角色名保持原文。',
        appendCameraMotionInstruction(stripSequencePrompt(String(original || '').trim()), movement),
    ].filter(Boolean).join('\n');
    const finalizedPrompt = withTkOverseasVisualLock(appendVideoDialoguePrompt(prompt, dialogue, breakdownMode), breakdownMode, '谜镜串行视频生成');
    return appendFirstFrameContinuityLock(finalizedPrompt, hasFirstFrame);
}
/** Build a local-only serial prompt. ComfyUI receives uploaded local image
 * names, so it must not be given Volc Asset URI syntax. */
export function buildComfyUiSequencePrompt(original, refs, hasFirstFrame, breakdownMode, dialogue, movement, previousCharacterNames = [], latentPlus = false, characterVoiceBindings = [], sourceScript = '') {
    dialogue = normalizeLocalVideoDialogue(dialogue, breakdownMode);
    if ((refs || []).some(item => ['first_frame', 'last_frame'].includes(String(item?.role || '').trim().toLowerCase()))) {
        throw new Error('本地 MiniMax H3 多参考链路禁止首帧/尾帧资产角色');
    }
    const cleanOriginal = stripSequencePrompt(String(original || '').trim());
    // Local H3 is R2V-only in both standard and Motion Context Plus modes.
    // Older storyboard text may still contain provider-specific frame wording;
    // pass a neutral, picture-list description so it cannot infer a FL2VA/I2V
    // request from stale prose.  The only continuity primitive exposed here is
    // current-shot Picture references (or the previous AV latent in Plus mode).
    const continuitySafeOriginal = stripLocalH3SpeechDirection(stripLocalFrameTerminology(cleanOriginal), dialogue);
    const compiledAssetOriginal = compileLocalAssetMentions(continuitySafeOriginal, refs);
    const shotDirection = appendCameraMotionInstruction(compiledAssetOriginal, movement);
    const castPlan = latentPlus ? '' : buildLocalH3CastPlan(refs, shotDirection, { hasVideoContinuity: hasFirstFrame, previousCharacterNames, sourceScript });
    const bindings = refs.map((item, index) => {
        const label = String(item.entityName || item.name || `reference ${index + 1}`).replace(/^角色-|^场景-|^道具-/, '').trim();
        const entityId = Number(item.entityId || 0);
        const entityMeta = entityId > 0 ? ` [binding_role=${String(item.role || '').trim().toLowerCase()}; entity_id=${entityId}]` : '';
        return `${index + 1}. ${referenceBindingLabel(item, label)}${entityMeta}${item.identityDescription ? ` [identity: ${item.identityDescription}]` : ''}`;
    }).join('; ');
    const pictureBindings = refs.map((item, index) => {
        const label = String(item.entityName || item.name || `reference ${index + 1}`).replace(/^角色-|^场景-|^道具-/, '').trim();
        const entityId = Number(item.entityId || 0);
        const entityMeta = entityId > 0 ? ` [binding_role=${String(item.role || '').trim().toLowerCase()}; entity_id=${entityId}]` : '';
        return `<Picture ${index + 1}> = ${referenceBindingLabel(item, label)}${entityMeta}${item.identityDescription ? ` [identity: ${item.identityDescription}]` : ''}`;
    }).join('; ');
    const assetAliasBindings = buildLocalAssetAliasBindings(refs);
    const sceneRefs = refs
        .map((item, index) => item.role === 'scene' ? `<Picture ${index + 1}>` : '')
        .filter(Boolean)
        .join(', ');
    const identityLocks = refs
        .map((item, index) => item.role === 'character' && item.entityName
        ? `${item.primary ? `PRIMARY PROTAGONIST ANCHOR: ` : ''}<Picture ${index + 1}> is the only identity source for ${referenceBindingLabel(item, item.entityName)}; preserve this person's face, hair, body type, clothing and age exactly${item.primary ? ', especially the exact outfit, colors, accessories and dirt/blood state shown in this local upload' : ''}.`
        : '')
        .filter(Boolean)
        .join(' ');
    const characterActionLocks = refs
        .filter(item => item.role === 'character' && item.entityName)
        .map(item => `${referenceBindingLabel(item, String(item.entityName || 'character'))} may perform only the actions and dialogue assigned to ${referenceBindingLabel(item, String(item.entityName || 'character'))} in the shot text; never give that person's face or actions to another character.`)
        .join(' ');
    const characterOutfitIsolation = refs
        .map((item, index) => item.role === 'character' && item.entityName
        ? `${referenceBindingLabel(item, String(item.entityName || 'character'))} may wear only the clothing, colors, accessories and visible wear shown in <Picture ${index + 1}>; never copy another Picture's wardrobe, color palette, blood pattern or costume onto this character.`
        : '')
        .filter(Boolean)
        .join(' ');
    const activeCharacterNames = [...new Set(refs
            .filter(item => item.role === 'character' && item.entityName)
            .map(item => String(item.entityName || '').trim())
            .filter(Boolean))];
    const dialogueVoiceNames = extractDialogueSpeakerNames(dialogue);
    const voiceCharacterNames = dialogueVoiceNames.length ? dialogueVoiceNames : (dialogue ? extractPromptVoiceNames(continuitySafeOriginal) : []);
    const voiceOwnershipLock = voiceCharacterNames.length
        ? `DIALOGUE SPEAKER OWNERSHIP: only ${voiceCharacterNames.join(', ')} may speak the scripted dialogue in this shot. The named speaker must use that character's own face, clothing and voice; never assign the line or its mouth movement to another referenced character. Dialogue speaker names are authoritative; ignore any stale or conflicting <voice> tag for another role.`
        : '';
    // A role tag can legitimately describe a hidden observer or a person
    // mentioned only in prose.  Keep the original screenplay text intact,
    // but explicitly quarantine any tagged name that has no active Picture
    // binding so H3 cannot turn a textual mention into an extra actor or map
    // it onto the protagonist.
    const excludedTaggedNames = extractRoleNames(cleanOriginal)
        .filter(name => !activeCharacterNames.some(active => characterNamesMatch(active, name)));
    const excludedRoleRule = excludedTaggedNames.length
        ? `EXCLUDED ROLE TAGS: ${[...new Set(excludedTaggedNames)].join(', ')} are not active visual characters in this shot. Keep any mention only as screenplay context; do not render them, do not give their face/clothing/actions to another role, and do not use them as an unlisted reference image.`
        : '';
    const primaryCharacter = refs.find(item => item.primary && item.role === 'character' && item.entityName);
    const primaryCharacterLock = primaryCharacter
        ? `PRIMARY CHARACTER CLOTHING LOCK: <Picture ${refs.indexOf(primaryCharacter) + 1}> is the locally uploaded master reference for ${referenceBindingLabel(primaryCharacter, String(primaryCharacter.entityName || 'character'))}. It is the authoritative source for ${referenceBindingLabel(primaryCharacter, String(primaryCharacter.entityName || 'character'))}'s face, hair, body, exact clothing layers, colors, accessories and visible wear/blood. Copy those details exactly in every frame; never use a generated replacement, a scene person, or another character image for ${referenceBindingLabel(primaryCharacter, String(primaryCharacter.entityName || 'character'))}. If the upload is a character sheet, read the full-body/front views as the clothing authority and ignore sheet labels, UUID text and interface graphics.`
        : '';
    const wardrobeOwnershipLocks = refs
        .filter(item => item.role === 'prop' && item.entityName)
        .map(item => {
        const owner = refs.find(character => character.role === 'character'
            && isCharacterOwnedProp({ name: item.entityName, type: item.name, description: item.identityDescription }, { name: character.entityName, aliases: character.aliases }));
        return owner
            ? `WARDROBE STORY-PROP BINDING: ${referenceBindingLabel(item, item.entityName)} is associated only with ${referenceBindingLabel(owner, owner.entityName)} as a separate screenplay prop. It must never override, replace or redefine that character's clothing in <Picture ${refs.indexOf(owner) + 1}>; if the prop is not explicitly visible as a separate object, omit it.`
            : '';
    })
        .filter(Boolean)
        .join(' ');
    const wardrobeConflictLock = refs
        .filter(item => item.role === 'character' && item.entityName)
        .map(character => {
        const owned = refs
            .filter(item => item.role === 'prop' && item.entityName
            && isCharacterOwnedProp({ name: item.entityName, type: item.name, description: item.identityDescription }, { name: character.entityName, aliases: character.aliases }))
            .map(item => item.entityName);
        if (!owned.length)
            return '';
        const others = refs
            .filter(item => item.role === 'character' && item.entityName && item !== character)
            .map(item => item.entityName)
            .filter(Boolean);
        return `STRICT WARDROBE PROP OWNERSHIP: ${owned.join(', ')} is associated only with ${character.entityName} as a separate screenplay prop. Never place or transfer it onto ${others.join(', ') || 'another character'}, and always resolve any clothing conflict in favor of each character's own Picture reference.`;
    })
        .filter(Boolean)
        .join(' ');
    const activeCharacterSet = latentPlus
        ? (activeCharacterNames.length
            ? `ACTIVE CHARACTER SET: only these named character identities may be active in this shot: ${activeCharacterNames.join(', ')}. Do not invent or exchange identities.`
            : 'ACTIVE CHARACTER SET: no named character identity is supplied for this shot; do not invent a character identity.')
            : (activeCharacterNames.length
            ? (hasFirstFrame
              ? `ACTIVE CHARACTER SET AFTER OPENING CONTINUITY: only these named character identities may be active in this shot: ${activeCharacterNames.join(', ')}. A person visible only inside <Video 1> but absent from this list is continuity-only; do not reuse that person's face, body, clothing or actions for any listed character, and do not keep that person as an active subject after the continuity hand-off.`
              : `ACTIVE CHARACTER SET: only these named character identities may be active in this shot: ${activeCharacterNames.join(', ')}. Do not invent or exchange identities.`)
            : (hasFirstFrame
              ? 'ACTIVE CHARACTER SET AFTER OPENING CONTINUITY: no named character identity is supplied for this shot; do not promote any person visible only in <Video 1> into a new role.'
              : 'ACTIVE CHARACTER SET: no named character identity is supplied for this shot; do not invent a character identity.'));
    const previousOnlyCharacters = [...new Set(previousCharacterNames
            .map(name => String(name || '').trim())
            .filter(name => name && !activeCharacterNames.includes(name)))];
    const previousOnlyRule = hasFirstFrame && !latentPlus && previousOnlyCharacters.length
        ? `PREVIOUS-CONTINUITY-ONLY IDENTITIES: ${previousOnlyCharacters.join(', ')} appear only in Video 1 from the previous shot. They are not characters in this shot: preserve them only during the video continuation, then remove them from active staging; never cast, name, animate or use their face, clothing or actions for ${activeCharacterNames.length ? activeCharacterNames.join(', ') : 'any current-shot role'}.`
        : '';
    const bilingualIdentityBindings = refs
        .filter(item => item.role === 'character' && item.entityName)
        .map(item => {
        const pictureNumber = refs.indexOf(item) + 1;
        const aliases = (item.aliases || []).filter(alias => normalizeAssetText(alias) !== normalizeAssetText(item.entityName || ''));
        return aliases.length
            ? `<Picture ${pictureNumber}> identity aliases: ${String(item.entityName || '').trim()} = ${aliases.join(', ')}. These names refer to this Picture only; never exchange this image with another role.`
            : '';
    })
        .filter(Boolean)
        .join(' ');
    const rules = latentPlus
        ? (hasFirstFrame
            ? 'MOTION CONTEXT PLUS CONTINUATION: continue this shot from the previous shot\'s AV latent state. The latent is the temporal continuity source; use the ordered multi-reference pictures only for their explicitly mapped identities and environment.'
            : 'MOTION CONTEXT PLUS OPENING SHOT: use only the ordered multi-reference pictures for their matching people, locations and props. Establish the opening composition and save the AV latent for the next shot.')
        : hasFirstFrame
            ? 'LOCAL SERIAL VIDEO CONTINUATION: <Video 1> carries the ending of the previous shot and its ending is only the temporal starting anchor. Extend that video with the current shot direction from its exact ending state; preserve continuity at the join, then visibly advance the current shot\'s own action and finish at a new result. Apply only this shot\'s current Picture references for their mapped people, location and props. Do not replace or exchange identities between picture references, and do not copy the previous ending as this shot\'s final state.'
            : 'LOCAL SERIAL GENERATION: this is the first shot. Use only the listed reference assets for their matching people, locations and props; do not invent or redesign them.';
    const standardContinuityContract = !latentPlus && hasFirstFrame
        ? [
            'STANDARD R2V VIDEO-EXTENSION CONTRACT:',
            '<Video 1> carries the ending of the previous shot and is the only temporal continuity source. Its final visible instant is the exact time-zero state of this shot; this shot is a direct extension of the previous shot, not a new opening, restart, re-staging or independent composition.',
            'At the join, preserve the previous shot camera, perspective, framing, subject positions, poses, gaze, hand and prop contact, lighting, background geometry and ongoing motion. Then execute only the current shot\'s CURRENT_SHOT_PROGRESS and finish at its distinct CURRENT_SHOT_END.',
            'Picture references are identity and appearance authorities only. They must never override <Video 1> at time zero, move a current character into a new starting pose, or make a previous-shot character impersonate another role. Character identity binding and temporal continuation are separate contracts; satisfy both.',
            'If the shot text contains CONTINUITY_START, CURRENT_SHOT_PROGRESS and CURRENT_SHOT_END, preserve that order and treat the three blocks as authoritative: inherit, advance, then reach a new result.',
        ].join('\n')
        : '';
    const promptorRef2vaContract = [
        'MINIMAX H3 PROMPTOR-STYLE REF2VA CONTRACT:',
        'Use exactly these six sections in this order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.',
        'Declare every current Picture label once in subject_definitions with its exclusive character, scene or prop role. Keep Picture numbers stable; never invent an unresolved picture label or remap a name to another picture.',
        'Use summary for one current-shot dramatic change, retention_analysis for explicit preserve-versus-change decisions, and detailed_description for a timed audiovisual timeline. The timeline must state the opening state, continuous action and camera path, current-shot result, and the exact handoff state without turning reference descriptions into a plot summary.',
        'For 4-6 seconds, use at most two coherent shot phases; for 7-10 seconds, at most three; for 11-15 seconds, at most four. Prefer one continuous take and physically motivated camera motion over rapid cuts or unrelated actions.',
        'overall_soundscape may contain only ambience, physical action sounds and non-verbal human sounds. non_diegetic_music may contain only audience-only music. Spoken words are authorized only by the injected dialogue plan and must never be copied from reference video, soundscape, music or visual narration.',
    ].join('\n')
    const unboundHumanSubjectLock = activeCharacterNames.length
        ? ''
        : [
            'UNBOUND HUMAN SUBJECT LOCK:',
            'No current character Picture is bound to this shot. Do not invent a named or detailed human character, face, body, costume or personal prop.',
            'If the shot direction explicitly contains an unidentified falling, flying or descending figure, render only the described distant supernatural silhouette or energy trail. Do not turn it into a detailed man or woman, do not assign a new identity, and do not give it any modern personal object or unlisted weapon.',
        ].join('\n');
    const currentShotContentBoundary = [
        'CURRENT SHOT CONTENT BOUNDARY:',
        'Use only the characters, scenes and props declared in this request, the temporal continuation source, and physical effects explicitly written in the shot direction.',
        'Do not add an unmentioned person, face, costume, weapon, prop, vehicle, electronic device, screen, interface, subtitle, logo or modern object. Do not turn a supernatural effect into a real-world object.',
        'A generic crowd or group may appear only when the current shot direction explicitly names that crowd or group; keep unnamed people indistinct and subordinate to the scripted action.',
    ].join('\n');
    const prompt = [
        `LOCAL COMFYUI REFERENCE ORDER (${refs.length} images): ${bindings}`,
        `PICTURE-TO-ASSET BINDINGS (use the image at this exact index and no other identity): ${pictureBindings}`,
        standardContinuityContract,
        castPlan,
        assetAliasBindings,
        bilingualIdentityBindings,
        sceneRefs ? (latentPlus
            ? `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} is the required location/background reference for this R2V shot. Preserve its architecture, layout, lighting and material throughout; never replace it with a blank/white background or another location.`
            : hasFirstFrame
              ? `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} defines the same location's identity and material details, not a new opening layout. The actual ending view of Video 1 controls the camera, visible background, spatial arrangement and lighting at the join; reveal further environment detail only through continuous movement. Never replace that inherited view with the scene image composition.`
              : `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} is the required location/background reference. Preserve its architecture, layout, lighting and material throughout the shot; use this scene image as the environment authority and do not let any character reference replace the background.`) : '',
        latentPlus
            ? `CHARACTER IDENTITY ISOLATION: ${identityLocks || 'Every named character must keep a unique identity from its own reference image.'} Never transfer a face, hairstyle, body shape, clothing or age from one character to another.`
            : `CHARACTER IDENTITY ISOLATION: ${identityLocks || 'Every named character must keep a unique identity from its own reference image.'} Never transfer a face, hairstyle, body shape, clothing or age from one character to another.${hasFirstFrame ? ' If a character enters after the continuity hand-off, use that character\'s own Picture reference; do not clone or relabel a visible person from Video 1 to perform the entrant\'s role.' : ''}`,
        primaryCharacterLock,
        wardrobeOwnershipLocks,
        wardrobeConflictLock,
        `CROSS-CHARACTER WARDROBE ISOLATION: ${characterOutfitIsolation || 'Every character must keep the clothing shown in its own reference image; never transfer clothing between roles.'}`,
        `CHARACTER ACTION OWNERSHIP: ${characterActionLocks || 'Keep every action and line assigned to its named character.'} Do not let a background person inherit another character's identity, clothing, expression or action.`,
        voiceOwnershipLock,
        activeCharacterSet,
        excludedRoleRule,
        previousOnlyRule,
        promptorRef2vaContract,
        unboundHumanSubjectLock,
        currentShotContentBoundary,
        latentPlus
            ? '每张参考图只对应上面映射的一个角色、场景或道具；本模式仅使用有序多参考图片和 Motion Context latent。角色关系文字（例如某人的父亲、女儿、老板或同事）只表示剧情关系，绝不能改变图片与角色名称的对应关系。禁止复制、合并、替换或交换任何角色身份，严格按图片序号使用。'
            : `每张 <Picture N> 只负责其映射的角色身份、场景或道具外观，不是上一镜的连续画面。${hasFirstFrame ? '<Video 1> 才是上一镜结尾画面和动作衔接来源，不能从其中复制人物来代替本镜新出场角色。' : '本镜没有上一镜视频参考。'}角色关系文字只表示剧情关系，不能更改角色与图片的绑定。禁止复制、合并、替换或交换任何角色身份；同一角色设定图的多个视角只代表同一个人。`,
        rules,
         // Do not add a provider frame-slot contract here. Standard serial
         // continuity is Video 1; Plus uses the AV latent instead.
        '',
        'Generate exactly one shot in sequence. Keep the same visual identity across shots and follow the original shot direction below.',
        latentPlus ? shotDirection : bindLocalH3ActionSubjects(shotDirection, refs),
        buildFinalCharacterAssetAuthority(refs),
    ].filter(Boolean).join('\n');
    const officialSubjectDefinitions = [
        'subject_definitions:',
        `LOCAL COMFYUI REFERENCE ORDER (${refs.length} images): ${bindings}`,
        `PICTURE-TO-ASSET BINDINGS: ${pictureBindings}`,
        ...refs.map((item, index) => {
            const role = String(item.role || '').trim().toLowerCase();
            const label = referenceBindingLabel(item, String(item.entityName || item.name || `reference ${index + 1}`).replace(/^(?:\u89d2\u8272-|\u573a\u666f-|\u9053\u5177-)/, '').trim());
            const picture = `<Picture ${index + 1}>`;
            if (role === 'character') return `<Subject ${index + 1}> is ${label}, exclusively represented by ${picture}. This picture is the sole source of this person's identity and static appearance.`;
            if (role === 'scene') return `<Subject ${index + 1}> is the required scene environment ${label}, exclusively represented by ${picture}.`;
            if (role === 'prop') return `<Subject ${index + 1}> is the screenplay prop ${label}, exclusively represented by ${picture}.`;
            return `${picture} is a supplied reference asset mapped only to ${label}.`;
        }),
        assetAliasBindings,
        bilingualIdentityBindings,
        'Reference labels are stable within this request. Never invent an unresolved Picture or Subject label, and never remap one picture to another identity.',
    ].filter(Boolean).join('\n');
    const officialSummary = [
        'summary:',
        hasFirstFrame && !latentPlus
            ? 'Reference-to-video generation for one continuous live-action shot extending directly from the ending of <Video 1>.'
            : latentPlus
                ? 'Reference-to-video generation for one continuous live-action shot using the Motion Context latent for temporal continuity.'
                : 'Reference-to-video generation for one continuous live-action opening shot using only the supplied scene, props and explicitly bound characters.',
        'Reach only the current scripted result. Do not add a character, prop, device, costume or event that is not explicitly bound or scripted.',
    ].join('\n');
    const officialRetentionAnalysis = [
        'retention_analysis:',
        standardContinuityContract,
        castPlan,
        currentShotContentBoundary,
        unboundHumanSubjectLock,
        sceneRefs ? (latentPlus
            ? `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} is the required location/background reference. Preserve its architecture, layout, lighting and material throughout; never replace it with another location.`
            : hasFirstFrame
                ? `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} defines the current location. The ending view of Video 1 controls the join; reveal further environment detail only through continuous movement.`
                : `MANDATORY SCENE ENVIRONMENT: ${sceneRefs} is the required location/background reference. Preserve its architecture, layout, lighting and material throughout.`) : '',
        latentPlus
            ? `CHARACTER IDENTITY ISOLATION: ${identityLocks || 'Every named character must keep a unique identity from its own reference image.'} Never transfer a face, hairstyle, body shape, clothing or age from one character to another.`
            : `CHARACTER IDENTITY ISOLATION: ${identityLocks || 'Every named character must keep a unique identity from its own reference image.'} Never transfer a face, hairstyle, body shape, clothing or age from one character to another.${hasFirstFrame ? ' If a character enters after the continuity hand-off, use that character\'s own Picture reference; do not relabel a visible person from Video 1.' : ''}`,
        primaryCharacterLock,
        wardrobeOwnershipLocks,
        wardrobeConflictLock,
        `CROSS-CHARACTER WARDROBE ISOLATION: ${characterOutfitIsolation || 'Every character must keep the clothing shown in its own reference image; never transfer clothing between roles.'}`,
        `CHARACTER ACTION OWNERSHIP: ${characterActionLocks || 'Keep every action and line assigned to its named character.'} Do not let a background person inherit another character's identity, clothing, expression or action.`,
        voiceOwnershipLock,
        activeCharacterSet,
        excludedRoleRule,
        previousOnlyRule,
        rules,
        latentPlus
            ? 'Each reference picture maps to one declared character, scene or prop. Relationship words describe story relations only and never change the picture-to-identity mapping.'
            : `Each <Picture N> supplies only its mapped character, scene or prop appearance. ${hasFirstFrame ? '<Video 1> supplies temporal continuation and cannot replace a current character identity.' : 'There is no previous video reference for this opening shot.'} Relationship words describe story relations only and never change the picture-to-identity mapping.`,
        buildFinalCharacterAssetAuthority(refs),
    ].filter(Boolean).join('\n');
    const officialDetailedDescription = [
        'detailed_description:',
        'Generate exactly one shot in sequence. Keep the visual identity stable and follow the current shot direction below.',
        latentPlus ? shotDirection : bindLocalH3ActionSubjects(shotDirection, refs),
    ].filter(Boolean).join('\n');
    const structuredPrompt = [
        officialSubjectDefinitions,
        officialSummary,
        officialRetentionAnalysis,
        officialDetailedDescription,
        'overall_soundscape:\nOnly the ambience, physical action sounds and non-verbal human sounds explicitly described in detailed_description.',
        'non_diegetic_music:\nOnly music explicitly requested by the shot direction; otherwise N/A.',
    ].join('\n\n');
    // The provider contract is authoritative here. Episodes created with an
    // older/other storyboard language (for example tk_overseas) can still be
    // rendered by the local H3 worker; never let that stale breakdown mode
    // disable the native speaker/voice lock for a local R2V request.
    const finalizedPrompt = withTkOverseasVisualLock(appendVideoDialoguePrompt(structuredPrompt, dialogue, breakdownMode, characterVoiceBindings, true), breakdownMode, 'Local ComfyUI MiniMax H3 serial video');
    // Keep the generated request safe even when a future prompt helper adds
    // provider-specific wording.  Sanitize only the local H3 copy; remote
    // providers retain their native contracts and parameters.
    // Local MiniMax H3 has no provider frame-slot inputs. Standard serial
    // continuity is the full Video 1 reference; Plus uses the AV latent.
    const safePrompt = sanitizeLocalH3Prompt(finalizedPrompt);
    // Keep the local contract fail-closed.  If a future prompt helper adds a
    // frame-slot token that the sanitizer did not understand, refuse to
    // enqueue the request instead of persisting a misleading snapshot that
    // will later be interpreted as FL2VA/I2V by the UI or worker.
    assertLocalH3PromptIsR2V(safePrompt);
    return safePrompt;
}

/**
 * Mirror ComfyUI-MiniMaxH3-MediaPrompt's useful @-mention convention for the
 * Studio local R2V prompt. In that node `角色=@media` is compiled before the
 * request into `角色=<Picture N>`; the model never receives a filename or an
 * unresolved @ token. Studio already knows the asset order, so emit the same
 * compiled symbol table automatically for canonical and bilingual names.
 */
export function buildLocalAssetAliasBindings(refs = []) {
    const entries = [];
    const aliasOwners = new Map();
    for (const [index, item] of (refs || []).entries()) {
        const picture = `<Picture ${index + 1}>`;
        const role = String(item?.role || '').trim().toLowerCase();
        const entityName = String(item?.entityName || '').trim();
        if (!entityName || role === 'continuity_reference' || role === 'first_frame' || role === 'last_frame')
            continue;
        const rawAliases = [entityName, ...parseAssetAliases(item?.aliases)]
            .map(value => String(value || '').trim().replace(/^@+/, ''))
            .filter(Boolean);
        const aliases = [];
        const seen = new Set();
        for (const alias of rawAliases) {
            const key = normalizeAssetText(alias);
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            aliases.push(alias);
            if (!aliasOwners.has(key))
                aliasOwners.set(key, new Set());
            aliasOwners.get(key).add(picture);
        }
        if (!aliases.length)
            continue;
        entries.push({ picture, role, entityName, aliases });
    }
    if (!entries.length)
        return '';
    const lines = entries.flatMap(entry => {
        const kind = entry.role === 'character' ? 'character identity'
            : entry.role === 'scene' ? 'scene environment'
                : entry.role === 'prop' ? 'prop identity'
                    : 'reference asset';
        const uniqueAliases = entry.aliases.filter(alias => aliasOwners.get(normalizeAssetText(alias))?.size === 1);
        return uniqueAliases.map(alias => {
            const canonical = normalizeAssetText(alias) === normalizeAssetText(entry.entityName);
            const description = `[${kind}${canonical ? '; canonical asset name' : '; alias of the canonical asset'}; this name refers exclusively to this picture]`;
            // MediaPrompt's editor turns `@asset` chips into `<Picture N>` at
            // execution time.  Studio has no editor chip, so persist the
            // compiled form and the equivalent human-readable declaration:
            // `角色名=@角色资产` -> `角色名=<Picture N>`.  Keeping the
            // canonical name without `@` makes the binding usable even when
            // the storyboard text was generated without an explicit mention.
            return [
                `@${alias} = ${entry.picture} ${description}`,
                `${alias} = ${entry.picture} ${description}`,
            ].join('\n');
        });
    });
    return [
        'COMPILED @ ASSET BINDINGS (authoritative symbol table; equivalent to writing NAME=@connected_asset in ComfyUI MediaPrompt):',
        ...lines,
        'Every canonical name, unambiguous alias, or matching @name in the shot text resolves to the declared <Picture N>. <role>NAME</role>, dialogue speaker names and asset actions must never be remapped to another image. If an alias is not declared because it is ambiguous, keep the original text and do not guess.',
    ].join('\n');
}

/** Compile optional manual `@asset-name` mentions exactly like the ComfyUI
 * MediaPrompt editor. Ambiguous aliases are intentionally left untouched so a
 * name can never silently select the wrong character image. */
export function compileLocalAssetMentions(prompt, refs = []) {
    const candidates = new Map();
    for (const [index, item] of (refs || []).entries()) {
        const role = String(item?.role || '').trim().toLowerCase();
        const entityName = String(item?.entityName || '').trim();
        if (!entityName || role === 'continuity_reference' || role === 'first_frame' || role === 'last_frame')
            continue;
        for (const alias of [entityName, ...parseAssetAliases(item?.aliases)]) {
            const display = String(alias || '').trim().replace(/^@+/, '');
            const key = normalizeAssetText(display);
            if (!key)
                continue;
            if (!candidates.has(key))
                candidates.set(key, []);
            candidates.get(key).push({ display, picture: `<Picture ${index + 1}>` });
        }
    }
    const replacements = [...candidates.values()]
        .filter(items => new Set(items.map(item => item.picture)).size === 1)
        .map(items => items[0])
        .sort((left, right) => right.display.length - left.display.length);
    let result = String(prompt || '');
    for (const { display, picture } of replacements) {
        // Chinese names are commonly followed immediately by another Chinese
        // word ("@苏小小进入厨房"), so do not require punctuation after a CJK
        // alias. Latin aliases keep a boundary to avoid replacing a shorter
        // alias inside a longer username/token.
        const suffix = /[\u3400-\u9fff]/u.test(display)
            ? ''
            : '(?=$|[\\s\\n，。！？；：、,.!?;:）》】}\\]])';
        const pattern = new RegExp(`@${escapeRegExp(display)}${suffix}`, 'giu');
        result = result.replace(pattern, picture);
    }
    return result;
}

/**
 * Local H3 prompts are sent to the multi-reference R2V node.  Keep this
 * assertion close to the prompt builder so a future edit cannot accidentally
 * reintroduce provider frame-slot terminology into either local mode.
 */
export function assertLocalH3PromptIsR2V(prompt) {
    const value = String(prompt || '');
    if (/(?:FL2VA|\bI2V\b|first(?:[-_ ]frame)|last(?:[-_ ]frame)|tail(?:[-_ ]frame)|opening(?:[-_ ]frame)|R2V\s+OPENING\s+FRAME|frame[-_ ]?0|首尾帧|首帧|第一帧|尾帧|第\s*0\s*帧)/i.test(value)) {
        throw new Error('本地 MiniMax H3 提示词包含已禁用的首尾帧/FL2VA/I2V术语');
    }
    return true;
}
function sanitizeLocalH3Prompt(prompt) {
    const value = String(prompt || '');
    const sanitized = value
        .replace(/R2V\s+OPENING\s+FRAME(?:\s+CONTRACT)?/gi, 'ordered R2V picture mapping')
        .replace(/\bopening(?:[-_ ]+frame)\b/gi, 'opening composition')
        .replace(/\bfirst(?:[-_ ]+frame)\b/gi, 'opening composition')
        .replace(/\blast(?:[-_ ]+frame)\b/gi, 'ending composition')
        .replace(/\btail(?:[-_ ]+frame)\b/gi, 'continuity image')
        .replace(/\b(?:first|last|tail)[-_ ]frame(?:_url)?\b/gi, 'continuity image')
        .replace(/\bframe[-_ ]?0\b/gi, 'opening composition')
        .replace(/\b(?:first|last|opening)[-_ ]frame\b/gi, 'opening composition')
        .replace(/首尾帧/g, '连续参考图')
        .replace(/首帧硬约束/g, '连续构图约束')
        .replace(/首帧/g, '开场构图')
        .replace(/第一帧/g, '开场画面')
        .replace(/尾帧/g, '连续参考图')
        .replace(/第\s*0\s*帧/g, '开场画面')
        .replace(/\bFL2VA\b/gi, 'legacy video path')
        .replace(/\bI2V\b/gi, 'single-image video path');
    // This assertion guards against accidental reintroduction while allowing
    // the normalized prose above to pass.
    assertLocalH3PromptIsR2V(sanitized);
    return sanitized;
}
function stripLocalFrameTerminology(value) {
    return String(value || '')
        .replace(/R2V\s+OPENING\s+FRAME(?:\s+CONTRACT)?/gi, 'ordered R2V picture mapping')
        .replace(/\bopening(?:[-_ ]+frame)\b/gi, 'opening composition')
        .replace(/previous\s+shot\s+tail\s+frame/gi, 'continuity image from previous shot')
        .replace(/previous\s+shot['’]?s\s+tail/gi, 'continuity image from previous shot')
        .replace(/\bfirst[- ]frame\b/gi, 'opening continuity image')
        .replace(/\blast[- ]frame\b/gi, 'continuity image')
        .replace(/\btail[- ]frame\b/gi, 'continuity image')
        .replace(/\b(?:first|last|tail)[-_ ]frame(?:_url)?\b/gi, 'continuity image')
        .replace(/\bend[- ]frame\b/gi, 'ending state')
        .replace(/\bframe\s*0\b/gi, 'opening composition')
        .replace(/首尾帧/g, '连续参考图')
        .replace(/首帧/g, '开场状态')
        .replace(/第一帧/g, '开场画面')
        .replace(/尾帧/g, '连续参考图')
        .replace(/第\s*0\s*帧/g, '开场画面')
        .replace(/第\s*0\s*秒/g, '开场时刻')
        .replace(/第\s*1\s*帧/g, '后续画面');
}
function stripLocalH3SpeechDirection(value, dialogue = '') {
    const spokenLines = String(dialogue || '')
        .split(/\r?\n/)
        .map(line => String(line || '').replace(/^\s*[^:：\n]{1,40}\s*[:：]\s*/, '').trim())
        .map(line => line.replace(/[\s\u3000\p{P}\p{S}]+/gu, '').toLocaleLowerCase())
        .filter(line => line.length >= 2);
    return String(value || '')
        .split(/\r?\n/)
        .filter(line => {
            const compact = line.replace(/[\s\u3000\p{P}\p{S}]+/gu, '').toLocaleLowerCase();
            return !spokenLines.some(spoken => compact.includes(spoken));
        })
        .join('\n')
        .replace(/\b(?:says?|speaks?|utters?|calls?|shouts?|yells?)\s+(?:once\s+)?(?:according to|from|as specified in)\s+(?:the\s+)?dialogue field/gi, 'performs the scripted visual speaking turn')
        .replace(/按\s*(?:dialogue|对白)\s*字段(?:原文)?(?:说出|发声|朗读)(?:一次)?/gi, '完成本段唯一口型动作')
        .replace(/根据\s*(?:dialogue|对白)\s*字段(?:原文)?(?:说出|发声|朗读)(?:一次)?/gi, '完成本段唯一口型动作')
        .replace(/(?:说出|发声|朗读)\s*(?:对白|台词)(?:一次)?/gi, '完成本段唯一口型动作');
}
export function buildGrokSequencePrompt(original, refs, hasFirstFrame, breakdownMode, dialogue, movement) {
    const cleanOriginal = stripGrokSequencePrompt(stripSequencePrompt(String(original || '').trim()));
    const rules = hasFirstFrame
        ? '这是串行生成的后续镜头；第一张参考图是上一镜头尾帧，必须作为本镜头第一帧严格承接，再按原分镜文本完成动作和镜头运动。'
        : '这是串行生成的第一个镜头；按原分镜文本开始生成，不要添加未提供的角色、场景或道具。';
    const bindings = refs.map((item, index) => `<IMAGE_${index + 1}>：${grokBindingLabel(item)}`);
    const prompt = [
        rules,
        'Grok Imagine 只使用公网图片 URL 或 base64 参考图，不使用火山 Asset URI；图片已经通过 reference_images 参数按以下顺序传输。',
        `参考图传输顺序（共 ${refs.length} 张，最多 7 张）：`,
        ...bindings,
        '必须按照上述映射使用对应参考图：首帧图负责连续性，角色图负责人物一致性，场景图负责环境一致性，道具图负责物件一致性；不要重新设计参考对象。',
        appendCameraMotionInstruction(cleanOriginal, movement),
    ].filter(Boolean).join('\n');
    const finalizedPrompt = withTkOverseasVisualLock(appendVideoDialoguePrompt(prompt, dialogue, breakdownMode), breakdownMode, 'Grok Imagine 串行视频生成');
    return appendFirstFrameContinuityLock(finalizedPrompt, hasFirstFrame);
}
/**
 * The storyboard extractor stores camera direction in its own `movement`
 * column. Keep that direction adjacent to the shot prompt so every video
 * provider receives it, rather than relying on the model to infer motion
 * from the action prose. The explicit contract is intentionally repeated in
 * English and Chinese because local MiniMax workflows may use either prompt
 * tokenizer.
 */
function appendCameraMotionInstruction(original, movement) {
    const cleanMovement = String(movement || '').trim();
    if (!cleanMovement)
        return original;
    const contract = [
        '【运镜硬约束 / CAMERA MOTION CONTRACT】',
        `本镜头必须执行以下 movement 字段，不得忽略或改成固定机位：${cleanMovement}`,
        '运镜要在视频中产生可见的摄影机位变化，并按 movement 的起点→方向→速度→焦点变化→最终落点连续完成；不得只让人物移动而摄影机保持锁定。',
        'The camera must visibly move according to the movement field (start point -> direction -> speed -> focus change -> end point). Do not use a fully locked-off/static camera; do not replace camera motion with subject-only motion.',
    ].join('\n');
    return [original, contract].filter(Boolean).join('\n');
}
function appendFirstFrameContinuityLock(prompt, hasFirstFrame) {
    if (!hasFirstFrame)
        return prompt;
    const lock = [
        '【首帧硬约束】上一镜尾帧是本镜头第 0 秒和第一帧的唯一视觉真值。',
        '第一帧必须严格复制其人物数量、姿势、表情、机位、景别、光线、服装、手持物以及前景和背景物件。',
        '第一帧严禁新增、删除、替换或移动任何人物或物体。',
        '角色、场景和道具参考图只用于第一帧之后（视频第 1 帧、也就是第二帧起）的外观一致性，不得在视频第 0 帧预先合成、覆盖或改写上一镜尾帧画面。',
        '首帧图中没有的箭、武器或其他道具，即使提供了对应参考图，也禁止提前出现在首帧；只能在视频开始运动后按剧情动作在正确时机进入画面。',
    ].join('\n');
    return `${prompt.trim()}\n${lock}`;
}
function stripGrokSequencePrompt(value) {
    const lines = value.split(/\r?\n/);
    const marker = lines.findIndex(line => /Grok Imagine 只使用公网|Grok Imagine reference-to-video|参考图传输顺序（共|参考图对应关系：/.test(line));
    return (marker >= 0 ? lines.slice(0, marker) : lines).join('\n').trim();
}
function grokBindingLabel(item) {
    if (item.role === 'first_frame')
        return '上一镜尾帧，本镜头首帧';
    return String(item.entityName || item.name || '参考资产').replace(/^角色-|^场景-|^道具-/, '').trim();
}
function stripSequencePrompt(value) {
    const lines = value.split(/\r?\n/);
    const kept = [];
    let skipping = false;
    for (const line of lines) {
        if (/^\s*连续镜头资产绑定[：:]/.test(line)) {
            skipping = true;
            continue;
        }
        if (skipping && /^\s*资产 ID 只在本段绑定中声明一次/.test(line)) {
            skipping = false;
            continue;
        }
        if (skipping)
            continue;
        kept.push(line);
    }
    return kept.join('\n').trim();
}
function formatAsset(asset) {
    const raw = formatSequenceAssetUri(asset).replace(/^Asset:\/\//, '');
    return `@asset://${raw}`;
}
function formatSequenceAssetUri(asset) {
    const raw = String(asset?.assetUri || asset?.providerAssetId || '').trim().replace(/^@+/, '');
    const assetId = raw.replace(/^asset:\/\//i, '');
    if (!assetId)
        throw new Error('火山资产缺少 asset URI');
    return `Asset://${assetId}`;
}
function bindingLabel(item) {
    if (item.role === 'first_frame')
        return '首帧画面';
    return String(item.entityName || item.name || '参考资产').replace(/^角色-|^场景-|^道具-/, '').trim();
}
function getEpisodeStoryboards(episodeId) {
    return db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().filter(item => !item.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber);
}
function getStoryboard(id) {
    const [row] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all();
    return row;
}
/** Resolve the current scene/character/prop whitelist for one storyboard.
 * Exported for offline audits and regression tests; it performs no uploads or
 * generation and uses the same resolver as the production serial pipeline. */
export function getStoryboardContext(storyboard) {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all();
    const [drama] = episode ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all() : [];
    // A model may put the location only in image_prompt/result (or dialogue),
    // so scene matching must inspect every persisted shot field. Otherwise a
    // valid scene asset is omitted even when the reference count is below nine,
    // producing a white/empty background in the generated video.
    const promptText = [
        storyboard.title,
        storyboard.location,
        storyboard.time,
        storyboard.videoPrompt,
        storyboard.action,
        storyboard.description,
        storyboard.result,
        storyboard.imagePrompt,
        storyboard.atmosphere,
        storyboard.dialogue,
    ].filter(Boolean).join('\n');
    const locationNames = extractLocationNames(promptText);
    const allScenes = db.select().from(schema.scenes).all();
    const episodeSceneIds = new Set(db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, storyboard.episodeId)).all()
        .map(link => link.sceneId));
    const episodeCharacterIds = new Set(db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, storyboard.episodeId)).all()
        .map(link => link.characterId));
    const episodePropIds = new Set(db.select().from(schema.episodeProps)
        .where(eq(schema.episodeProps.episodeId, storyboard.episodeId)).all()
        .map(link => link.propId));
    // Once the episode has explicit scene links, never fall back to another
    // scene from the same drama.  For legacy rows without link records, prefer
    // scenes explicitly carrying this episode_id; only use drama-level rows
    // when no episode-scoped scene exists at all. This prevents a stale scene
    // from another episode from replacing the current background.
    const episodeScopedScenes = allScenes.filter(item => item.episodeId === storyboard.episodeId);
    const sceneCandidates = episodeSceneIds.size
        ? allScenes.filter(item => episodeSceneIds.has(item.id))
        : episodeScopedScenes.length
            ? episodeScopedScenes
            : allScenes.filter(item => item.dramaId === episode?.dramaId && item.episodeId == null);
    const requestedLocation = String(storyboard.location || '').trim();
    // A shot may mention a destination while describing a camera move (for
    // example “from the kitchen to the dining room”). The top-level location is
    // the authoritative opening environment. If it is absent, use only the
    // first canonical <location> tag; considering every tag makes scene
    // matching ambiguous and can select an old/wrong background.
    const effectiveLocationNames = requestedLocation
        ? [requestedLocation]
        : locationNames.slice(0, 1);
    const requestedTime = String(storyboard.time || '').trim();
    const normalizedPromptText = normalizeEntityText(promptText);
    const promptScene = sceneCandidates
        .filter(item => sceneMatchesStoryboardText(item, {
        requestedLocation,
        requestedTime,
        promptText,
        normalizedPromptText,
        locationNames: effectiveLocationNames,
    }))
        .sort((a, b) => sceneCandidateScore(b, requestedLocation, requestedTime, promptText, effectiveLocationNames)
        - sceneCandidateScore(a, requestedLocation, requestedTime, promptText, effectiveLocationNames)
        // If legacy data has no episode_scenes link, prefer a scene explicitly
        // created for this episode over an older same-drama scene with the same
        // location name. This avoids silently injecting a stale background.
        || Number(b.episodeId === storyboard.episodeId) - Number(a.episodeId === storyboard.episodeId)
        || Number(b.id) - Number(a.id))[0];
    // A stale scene_id can survive a re-decomposition.  When the episode has an
    // explicit scene white-list, the id must belong to that white-list too;
    // accepting any scene from the same drama silently injects the old scene
    // (or drops the current scene) even though the reference count is valid.
    const hasEpisodeScopedScenes = allScenes.some(item => item.episodeId === storyboard.episodeId);
    const explicitScene = storyboard.sceneId
        ? allScenes.find(item => item.id === storyboard.sceneId
            && !item.deletedAt
            && (episodeSceneIds.size
                ? episodeSceneIds.has(item.id)
                : (item.episodeId === storyboard.episodeId
                    || (!hasEpisodeScopedScenes && item.episodeId == null && item.dramaId === episode?.dramaId))))
        : null;
    // An explicit storyboard binding is authoritative. Prompt text may mention
    // another location in an action line; it must never override scene_id.
    // If the episode has exactly one linked scene, it is authoritative even
    // when the model omitted/varied the location wording. This prevents a valid
    // scene asset from disappearing (and a white background from being used)
    // merely because `scene_id` was null or the text used a synonym.
    // A single linked scene is unambiguous even when the model paraphrases or
    // omits the location field during re-decomposition.  Requiring the text to
    // match here made valid scene assets disappear (and produced white
    // backgrounds) although the episode had exactly one legal scene and the
    // reference-image budget was still available.
    const soleEpisodeScene = episodeSceneIds.size === 1
        ? sceneCandidates.find(item => !item.deletedAt)
        : null;
    const scene = explicitScene || promptScene || soleEpisodeScene;
    const linkedIds = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboard.id)).all().map(item => item.characterId);
    const roleNames = extractRoleNames(promptText);
    const allCharacters = db.select().from(schema.characters).all()
        .filter(item => !item.deletedAt
        && item.dramaId === (drama?.id || episode?.dramaId)
        && (!episodeCharacterIds.size || episodeCharacterIds.has(item.id)));
    // Associations may contain the whole episode cast. Use every character
    // explicitly mentioned by this shot (including names in action/dialogue),
    // excluding only names that are explicitly marked as off-screen. Falling
    // back to associations is safe only when the shot text has no character
    // names at all.
    const normalizedPrompt = normalizeEntityText(promptText);
    const exactTaggedCharacterNames = roleNames.filter(name => (allCharacters.some(item => characterNamesMatch(item, name))));
    // Role tags are also used by the extractor for off-screen observers and
    // distant silhouettes. Those people must remain in the screenplay text,
    // but their portraits must not enter the current shot's R2V identity list:
    // H3 can otherwise cast the hidden portrait into frame 0 or swap it with
    // the protagonist. Keep only characters with explicit visible/on-screen
    // evidence (or no background-only evidence at all).
    const visibleTaggedCharacterNames = exactTaggedCharacterNames.filter(name => {
        const character = allCharacters.find(item => characterNamesMatch(item, name));
        return !character || !isCharacterBackgroundOnlyMention(promptText, character);
    });
    const mentionedCharacterNames = allCharacters
        .filter(item => {
        const name = String(item.name || '').trim();
        return name
            && characterNameAppears(normalizedPrompt, item)
            && !isRelationshipOnlyCharacterMention(promptText, name)
            && !isCharacterExplicitlyAbsent(promptText, name)
            && !isCharacterBackgroundOnlyMention(promptText, item);
    });
    // Current role/name mentions are authoritative.  Old storyboard links are
    // only a fallback for a genuinely empty prompt; otherwise they can bring a
    // previous shot's character back and make one actor inherit another's face.
    const completeRoleTags = roleNames.length > 0 && exactTaggedCharacterNames.length === roleNames.length;
    const resolvedCharacters = roleNames.length
        ? allCharacters.filter(item => !isCharacterBackgroundOnlyMention(promptText, item) && (visibleTaggedCharacterNames.some(name => characterNamesMatch(name, item))
            // A complete tag set is the model's primary binding, but descriptions
            // can still explicitly show another person without emitting a tag.
            // Include that deterministic name match so a visible actor's reference
            // image is never silently omitted. Unknown/incomplete tags remain
            // conservative and are rejected by save_storyboards as before.
            || (completeRoleTags && mentionedCharacterNames.some(name => Number(name.id) === Number(item.id)))))
        : mentionedCharacterNames.length
            ? mentionedCharacterNames
            : linkedIds.length
                ? allCharacters.filter(item => linkedIds.includes(item.id))
                : [];
    // Final defensive pass: even if a legacy association or the complete-tag
    // fallback added an observer back, never expose a metadata-marked
    // background-only person as an active reference image.
    const characters = resolvedCharacters.filter(item => !isCharacterBackgroundOnlyMention(promptText, item));
    // Re-decomposition can leave legacy storyboard_characters rows behind when
    // an older save used the whole episode cast.  Once every role tag resolves
    // to a known character, repair that association so the UI count and the
    // generation context use the same exact identities (without touching an
    // invalid/partially resolved prompt).
    if (completeRoleTags) {
        const exactIds = characters.map(item => Number(item.id)).filter(Boolean);
        const linkedSorted = [...new Set(linkedIds)].sort((a, b) => a - b);
        const exactSorted = [...new Set(exactIds)].sort((a, b) => a - b);
        if (linkedSorted.length !== exactSorted.length || linkedSorted.some((id, index) => id !== exactSorted[index])) {
            db.delete(schema.storyboardCharacters)
                .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id))
                .run();
            for (const characterId of exactSorted) {
                db.insert(schema.storyboardCharacters).values({ storyboardId: storyboard.id, characterId }).run();
            }
        }
    }
    const projectProps = db.select().from(schema.props).all().filter(prop => prop.dramaId === (drama?.id || episode?.dramaId)
        && !prop.deletedAt
        && prop.name);
    // Keep the episode whitelist as a preference, but recover a clearly
    // mentioned project asset when extraction failed to create its link. This
    // is safe because matching is deterministic and still requires the asset to
    // belong to this drama and to be named in the current shot text.
    const allProps = projectProps.filter(prop => !episodePropIds.size || episodePropIds.has(prop.id) || propMatchesStoryboardText(prop, storyboard, projectProps));
    const props = allProps.filter(prop => propMatchesStoryboardText(prop, storyboard, projectProps));
    return {
        episodeId: episode?.id || storyboard.episodeId,
        dramaId: drama?.id || episode?.dramaId || 0,
        scene,
        characters,
        props,
        // Count the actual candidate pool, not only episode_scenes links. Legacy
        // projects may have scene rows with episode_id but no link row; treating
        // that case as "zero scenes" silently allowed a white background when a
        // shot failed to resolve. Any non-empty candidate pool now requires a
        // scene match before a video request can be queued.
        episodeSceneCount: sceneCandidates.length,
        allCharacterNames: allCharacters.map(item => String(item.name || '').trim()).filter(Boolean),
    };
}
function normalizeEntityText(value) {
    return String(value || '').trim().replace(/[\s\u3000]+/g, '').toLocaleLowerCase();
}
function sameEntityText(left, right) {
    const a = normalizeEntityText(left);
    const b = normalizeEntityText(right);
    return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
function sceneCandidateScore(scene, requestedLocation, requestedTime, promptText, locationNames) {
    const location = String(scene.location || '').trim();
    const normalizedPrompt = normalizeEntityText(promptText);
    const scenePrompt = normalizeEntityText(scene.prompt);
    const locationMatch = sceneLocationMatchesAsset(requestedLocation, scene);
    let score = locationMatch ? 100 : locationNames.some(name => sceneLocationMatchesBinding(normalizeEntityText(name), normalizeEntityText(location))) ? 70 : (location && normalizedPrompt.includes(normalizeEntityText(location)) ? 30 : 0);
    if (!score && scenePrompt && normalizedPrompt.includes(scenePrompt))
        score = 20;
    if (requestedTime && String(scene.time || '').trim() === requestedTime)
        score += 20;
    return score;
}
/** Match a storyboard to a scene asset using every stable scene descriptor.
 * Models frequently paraphrase `location` after re-decomposition, while the
 * persisted scene prompt still contains the exact environment description.
 * Matching that prompt prevents a valid scene image from being dropped even
 * when the reference count is below the provider limit. */
export function sceneMatchesStoryboardText(scene, input) {
    if (scene.deletedAt)
        return false;
    const requestedLocation = String(input.requestedLocation || '').trim();
    const requestedTime = String(input.requestedTime || '').trim();
    const promptText = String(input.promptText || '');
    const normalizedPromptText = String(input.normalizedPromptText || normalizeEntityText(promptText));
    const locationNames = input.locationNames || [];
    const location = String(scene.location || '').trim();
    const scenePrompt = String(scene.prompt || '').trim();
    const hasExplicitOpeningLocation = !!requestedLocation || locationNames.length > 0;
    const locationMatch = sameEntityText(location, requestedLocation)
        || sceneLocationMatchesAsset(requestedLocation, scene)
        || locationNames.some(name => sceneLocationMatchesAsset(name, scene))
        || (!hasExplicitOpeningLocation && !!location && normalizedPromptText.includes(normalizeEntityText(location)))
        || (!hasExplicitOpeningLocation && !!scenePrompt && normalizedPromptText.includes(normalizeEntityText(scenePrompt)));
    if (!locationMatch)
        return false;
    const sceneTime = String(scene.time || '').trim();
    return !requestedTime || !sceneTime || sameEntityText(sceneTime, requestedTime);
}
/** Keep scene matching tolerant to the wording used by the storyboard model
 * while remaining deterministic.  These are location aliases only; they do
 * not create new scenes or allow a scene from another episode. */
function sceneLocationVariants(value) {
    const normalized = normalizeEntityText(value);
    const variants = new Set(normalized ? [normalized] : []);
    const aliases = [
        ['厨房', '后厨'],
        ['店内', '店里'],
        ['室内', '屋内'],
        ['起居室', '客厅'],
        ['卧房', '卧室'],
    ];
    for (const [left, right] of aliases) {
        if (normalized.includes(left))
            variants.add(normalized.replaceAll(left, right));
        if (normalized.includes(right))
            variants.add(normalized.replaceAll(right, left));
    }
    return [...variants];
}
function sceneLocationMatchesBinding(left, right) {
    if (!left || !right)
        return false;
    return sceneLocationVariants(left).some(a => sceneLocationVariants(right).some(b => a === b || a.includes(b) || b.includes(a)));
}
function sceneLocationMatchesAsset(left, scene) {
    const normalizedLeft = normalizeEntityText(left);
    if (!normalizedLeft)
        return false;
    return assetBindingTerms({ name: scene.location, aliases: scene.aliases, englishName: scene.englishName, english_name: scene.english_name })
        .some(term => sceneLocationMatchesBinding(normalizedLeft, normalizeEntityText(term)));
}
function containsEntityName(prompt, name) {
    const normalizedName = normalizeEntityText(name);
    return !!normalizedName && prompt.includes(normalizedName);
}
/** A role may be tagged only to state that it is not visible in this shot. */
export function isCharacterExplicitlyAbsent(prompt, name) {
    const normalizedName = normalizeEntityText(name);
    if (!normalizedName)
        return false;
    // Remove role/location markup before matching phrases such as
    // `<role>苏大强</role>未入画`.
    const source = normalizeEntityText(prompt).replace(/<[^>]+>/g, '');
    const absent = '(?:未入画|暂未入画|尚未入画|未出现|不在画面|不入画|不出现)';
    return new RegExp(`${escapeRegExp(normalizedName)}[\\s,，。；;:：、-]*${absent}`).test(source);
}
/** A name appearing only as the target of a family/role relationship is not
 * evidence that the person is visible in the shot. */
export function isRelationshipOnlyCharacterMention(prompt, name) {
    const normalizedName = normalizeEntityText(name);
    if (!normalizedName)
        return false;
    const source = normalizeEntityText(prompt).replace(/<[^>]+>/g, '');
    let offset = source.indexOf(normalizedName);
    while (offset >= 0) {
        const before = source.slice(Math.max(0, offset - 8), offset);
        const after = source.slice(offset + normalizedName.length, offset + normalizedName.length + 8);
        if (/的(?:父亲|母亲|女儿|儿子|丈夫|妻子|哥哥|姐姐|弟弟|妹妹|父亲|母亲|老板|店主|同事|朋友)/.test(after)
            || /(?:父亲|母亲|女儿|儿子|丈夫|妻子|哥哥|姐姐|弟弟|妹妹|老板|店主|同事|朋友)的$/.test(before)) {
            offset = source.indexOf(normalizedName, offset + normalizedName.length);
            continue;
        }
        return false;
    }
    return true;
}
/** Resolve background-only status per character clause. Commas are meaningful
 * in shot prose: a sentence can describe a foreground actor and a different
 * actor in the background. Never let the latter hide the former. */
export function isCharacterBackgroundOnlyMention(prompt, character) {
    const source = String(prompt || '');
    const variants = characterBindingNames(character || {})
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    if (!source || !variants.length)
        return false;
    const compact = normalizeAssetText(source);
    const backgroundMarker = /(?:暗处|暗中|远处|远景|远端|后方|背景(?:处|中)?|画外|场外|未正面现身|不在画面|未入画|仅(?:有|剩)?(?:声音|剪影|身影)|仅仅?是?(?:声音|剪影|身影)|off(?:screen)?|silhouette|hidden|distant|barelyvisible|onlyadim|background|backgroundobserver|notvisible)/i;
    const visibleAction = /(?:站在|位于|坐在|躺在|跪在|走入|走进|出现在|入画|现身|手持|抓住|按住|看着|注视|说话|开口|stands?|sits?|lies?|kneels?|enters?|walksin|appears?|holds?|grips?|looks?at|speaks?)/i;
    const explicitAbsent = /(?:未入画|未正面现身|不在画面|offscreen|silhouette|hidden|distant|barelyvisible|onlyadim)/i;
    let found = false;
    for (const value of variants) {
        const needle = normalizeAssetText(value);
        if (!needle)
            continue;
        let offset = compact.indexOf(needle);
        while (offset >= 0) {
            found = true;
            const left = Math.max(
                compact.lastIndexOf('.', offset), compact.lastIndexOf('。', offset),
                compact.lastIndexOf(';', offset), compact.lastIndexOf('；', offset),
                compact.lastIndexOf(',', offset), compact.lastIndexOf('，', offset),
                compact.lastIndexOf('!', offset), compact.lastIndexOf('！', offset),
                compact.lastIndexOf('?', offset), compact.lastIndexOf('？', offset),
                compact.lastIndexOf('\n', offset),
            );
            const rightCandidates = [
                compact.indexOf('.', offset + needle.length), compact.indexOf('。', offset + needle.length),
                compact.indexOf(';', offset + needle.length), compact.indexOf('；', offset + needle.length),
                compact.indexOf(',', offset + needle.length), compact.indexOf('，', offset + needle.length),
                compact.indexOf('!', offset + needle.length), compact.indexOf('！', offset + needle.length),
                compact.indexOf('?', offset + needle.length), compact.indexOf('？', offset + needle.length),
                compact.indexOf('\n', offset + needle.length),
            ].filter(index => index >= 0);
            const clause = compact.slice(left + 1, rightCandidates.length ? Math.min(...rightCandidates) : compact.length)
                .replace(/<role>[^<]*<\/role>/gi, ' ');
            const after = compact.slice(offset + needle.length, offset + needle.length + 90);
            if (!explicitAbsent.test(clause) && visibleAction.test(after))
                return false;
            if (explicitAbsent.test(clause) || backgroundMarker.test(clause))
                return true;
            offset = compact.indexOf(needle, offset + needle.length);
        }
    }
    // Metadata marks a role as an observer only when the shot text provides no
    // concrete foreground action for that role. A bare role tag therefore
    // remains hidden, while a visible “lies/stands/holds” clause wins.
    const metadata = [character?.role, character?.description, character?.appearance]
        .map(value => String(value || '')).join('');
    const metadataBackground = /(?:暗中观察|暗处|隐藏|未正面现身|剪影|观察者|off[- ]?screen|silhouette|hidden|distant observer|background observer)/i.test(metadata.replace(/[\s\u3000]+/g, ''));
    return found && metadataBackground && !variants.some(value => {
        const needle = normalizeAssetText(value);
        let index = compact.indexOf(needle);
        while (index >= 0) {
            const after = compact.slice(index + needle.length, index + needle.length + 90);
            if (visibleAction.test(after) && !explicitAbsent.test(after))
                return true;
            index = compact.indexOf(needle, index + needle.length);
        }
        return false;
    });
}

/** Return true when a named character is explicitly background-only in this
 * shot (for example a distant silhouette, off-screen observer or voice). The
 * screenplay/tag is preserved, but its portrait is not sent as an active H3
 * identity reference. This deliberately requires textual evidence in the
 * current shot; character metadata alone must never hide a legitimately visible
 * actor. */
function isCharacterBackgroundOnlyMentionLegacy(prompt, character) {
    const source = String(prompt || '');
    const variants = characterBindingNames(character || {})
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    if (!source || !variants.length)
        return false;
    // Resolve visibility per named character before the legacy sentence-wide
    // scan below. A sentence may contain several people; applying one person's
    // background marker to every name is what previously removed foreground
    // protagonists (for example Fengxi was hidden by Bai Ling's "soft
    // background" clause). The local window is intentionally directional:
    // actions immediately following the name belong to that name, while a
    // background marker on another person's clause does not.
    const metadataHint = [character?.role, character?.description, character?.appearance]
        .map(value => String(value || ''))
        .join(' ');
    const metadataBackgroundHint = /(?:\u6697\u4e2d\u89c2\u5bdf|\u6697\u5904|\u9690\u85cf|\u672a\u6b63\u9762\u73b0\u8eab|\u526a\u5f71|\u89c2\u5bdf\u8005|off[- ]?screen|silhouette|hidden|distant observer|background observer)/i.test(metadataHint.replace(/[\s\u3000]+/g, ''));
    const compactLocalSource = normalizeAssetText(source);
    const localBackgroundMarker = /(?:\u6697\u5904|\u6697\u4e2d|\u8fdc\u5904|\u8fdc\u666f|\u8fdc\u7aef|\u540e\u65b9|\u80cc\u666f(?:\u5904|\u4e2d)?|\u753b\u5916|\u573a\u5916|\u672a\u6b63\u9762\u73b0\u8eab|\u4e0d\u5728\u753b\u9762|\u672a\u5165\u753b|background|off(?:screen)?|silhouette|hidden|distant|barelyvisible|onlyadim|backgroundobserver|notvisible)/i;
    const localVisibleAction = /(?:\u7ad9\u5728|\u4f4d\u4e8e|\u5750\u5728|\u8eba\u5728|\u8dea\u5728|\u8d70\u5165|\u8d70\u8fdb|\u51fa\u73b0\u5728|\u5165\u753b|\u73b0\u8eab|\u624b\u6301|\u6293\u4f4f|\u6309\u4f4f|\u770b\u7740|\u6ce8\u89c6|\u8bf4\u8bdd|\u5f00\u53e3|stands?|sits?|lies?|kneels?|enters?|walksin|appears?|holds?|grips?|looks?at|speaks?)/i;
    for (const value of variants) {
        const needle = normalizeAssetText(value);
        if (!needle)
            continue;
        let index = compactLocalSource.indexOf(needle);
        while (index >= 0) {
            const after = compactLocalSource.slice(index + needle.length, index + needle.length + 100);
            const before = compactLocalSource.slice(Math.max(0, index - 45), index);
            const explicitAbsent = /(?:\u672a\u5165\u753b|\u672a\u6b63\u9762\u73b0\u8eab|\u4e0d\u5728\u753b\u9762|offscreen|silhouette|hidden|distant)/i.test(after);
            if (!explicitAbsent && localVisibleAction.test(after))
                return false;
            if (explicitAbsent || localBackgroundMarker.test(after))
                return true;
            // A background marker immediately before the name is only
            // authoritative when no concrete action for this name follows.
            if (metadataBackgroundHint && localBackgroundMarker.test(before) && !localVisibleAction.test(after))
                return true;
            index = compactLocalSource.indexOf(needle, index + needle.length);
        }
    }
    // Keep metadata-only observers hidden when their shot text contains no
    // conflicting foreground action, without allowing metadata to hide a
    // regular character whose own clause is foreground/ambiguous.
    if (metadataBackgroundHint)
        return true;
    /* legacy sentence-wide implementation removed; kept below only in git history */
    /*
    // Metadata from extraction is a stronger signal than a role tag.  A
    // character explicitly defined as an observer/hidden/silhouette must not
    // consume an active identity slot in any shot unless the shot text also
    // gives that person a concrete on-screen action (handled below).
    const metadata = [character?.role, character?.description, character?.appearance]
        .map(value => String(value || ''))
        .join(' ');
    const metadataBackgroundOnly = /(?:暗中观察|暗处|隐藏|未正面现身|仅(?:有|剩)?声音|剪影|观察者|off[- ]?screen|silhouette|hidden|distant observer|background observer)/i.test(metadata.replace(/[\s\u3000]+/g, ''));
    if (metadataBackgroundOnly) {
        const compact = normalizeAssetText(source);
        const backgroundMarker = /(?:暗中观察|暗处|隐藏|未正面现身|仅(?:有|剩)?声音|剪影|观察者|off(?:screen)?|silhouette|hidden|distant|barelyvisible|onlyadim|backgroundobserver|notvisible)/i;
        // Evaluate each alias occurrence in its own compact sentence. This
        // avoids a nearby “Fengxi lies …” or another actor's “stands” from
        // making a hidden Feng Yue appear visible.
        for (const value of variants) {
            const needle = normalizeAssetText(value);
            let index = compact.indexOf(needle);
            while (index >= 0) {
                const end = compact.indexOf('.', index + needle.length);
                const sentence = compact.slice(Math.max(0, compact.lastIndexOf('.', index) + 1), end >= 0 ? end + 1 : compact.length);
                if (backgroundMarker.test(sentence))
                    return true;
                index = compact.indexOf(needle, index + needle.length);
            }
        }
    }
    const metadataVisible = variants.some(value => {
        const needle = normalizeAssetText(value);
        if (!needle)
            return false;
        const compact = normalizeAssetText(source);
        let index = compact.indexOf(needle);
        while (index >= 0) {
            // Only accept a visible action close to this character's own name.
            // A different person's “stands” in the same sentence must not make
            // a hidden observer visible; role-tag headers are ignored naturally
            // because they contain no action verb near the tag.
            const context = compact.slice(Math.max(0, index - 45), index + needle.length + 80);
            if (/(?:站在|位于|坐在|躺在|跪在|走入|走进|出现在|入画|现身|手持|抓住|按住|看着|注视|说话|开口|stands?|sits?|lies?|kneels?|enters?|walksin|appears?|holds?|grips?|looks?at|speaks?)/i.test(context)
                && !/(?:onlyadim|silhouette|hidden|offscreen|distant|barelyvisible|未入画|未正面现身|暗处)/i.test(context))
                return true;
            index = compact.indexOf(needle, index + needle.length);
        }
        return false;
    });
    if (metadataBackgroundOnly && !metadataVisible)
        return true;
    // Match both the original prose and a compact form so aliases such as
    // “Feng Yue” still match the normalized binding term “fengyue”.
    const compactSource = normalizeAssetText(source);
    const backgroundOnly = /(?:暗处|暗中|远处|远景|远端|后方|背景(?:处|中)?|画外|场外|未正面现身|不在画面|未入画|仅(?:有|剩)?(?:声音|剪影|身影)|仅仅?是?(?:声音|剪影|身影)|(?:剪影|身影).*(?:模糊|暗处|远处|不可见)|off(?:screen)?|silhouette|hidden|distant|barelyvisible|onlyadim|only.*(?:voice|silhouette)|backgroundobserver|notvisible)/i;
    // Do not use the bare word “visible” here: it is part of
    // “barelyvisible”, which is itself background-only evidence after
    // punctuation/whitespace compaction.
    const visibleEvidence = /(?:站在|位于|坐在|躺在|跪在|走入|走进|出现在|入画|手持|抓住|按住|看着|注视|说话|开口|stands?|sits?|lies?|kneels?|enters?|walksin|appears?|holds?|grips?|looks?at|speaks?)/i;
    let matched = false;
    for (const variant of variants) {
        const needle = normalizeAssetText(variant);
        let offset = compactSource.indexOf(needle);
        while (offset >= 0) {
            // A bare <role> tag is not evidence either way. Inspect only the
            // sentence containing this occurrence. Looking at a wide window
            // would accidentally see “elder stands” before a hidden “Feng Yue”
            // and classify the hidden character as visible.
            const leftBoundary = Math.max(
                compactSource.lastIndexOf('.', offset),
                compactSource.lastIndexOf('。', offset),
                compactSource.lastIndexOf(';', offset),
                compactSource.lastIndexOf('；', offset),
                compactSource.lastIndexOf('!', offset),
                compactSource.lastIndexOf('！', offset),
                compactSource.lastIndexOf('?', offset),
                compactSource.lastIndexOf('？', offset),
                compactSource.lastIndexOf('\n', offset),
            );
            const rightBoundaries = [
                compactSource.indexOf('.', offset + needle.length),
                compactSource.indexOf('。', offset + needle.length),
                compactSource.indexOf(';', offset + needle.length),
                compactSource.indexOf('；', offset + needle.length),
                compactSource.indexOf('!', offset + needle.length),
                compactSource.indexOf('！', offset + needle.length),
                compactSource.indexOf('?', offset + needle.length),
                compactSource.indexOf('？', offset + needle.length),
                compactSource.indexOf('\n', offset + needle.length),
            ].filter(index => index >= 0);
            const context = compactSource
                .slice(leftBoundary + 1, rightBoundaries.length ? Math.min(...rightBoundaries) : compactSource.length)
                .replace(/<role>[^<]*<\/role>/gi, ' ');
            if (backgroundOnly.test(context)) {
                matched = true;
                if (visibleEvidence.test(context))
                    return false;
            }
            offset = compactSource.indexOf(needle, offset + needle.length);
        }
    }
    return matched;*/
    return false;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function getEntityImageUrl(entity) {
    const imageUrl = String(entity.imageUrl || '').trim();
    const localPath = String(entity.localPath || '').trim();
    // Prefer a readable local copy. A stale remote image_url must not hide a
    // generated/uploaded asset that ComfyUI can still read from local_path.
    if (localPath && isReadableLocalImage(localPath))
        return localPath;
    return imageUrl || localPath;
}
function isReadableLocalImage(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return false;
    const normalized = raw.startsWith('/static/') ? raw.slice(1) : raw;
    const absolute = normalized.startsWith('static/')
        ? getAbsolutePath(normalized)
        : path.isAbsolute(normalized) ? normalized : null;
    return !!absolute && fs.existsSync(absolute);
}
/** Identify the episode lead from the persisted asset metadata.  A lead
 * reference receives a deterministic slot and a stronger clothing lock, but
 * this never changes the character whitelist or invents an asset. */
function isPrimaryCharacter(character) {
    const role = normalizeEntityText(character.role);
    return /主角|女主|男主|protagonist|lead|maincharacter/.test(role);
}
export function characterIdentityDescription(character, knownCharacterNames = []) {
    const ownName = normalizeEntityText(character?.name || '');
    // Manual uploads are deliberately authoritative.  Their persisted
    // appearance text often came from screenplay extraction and can describe a
    // different costume (for example a fantasy robe versus a user-supplied
    // modern costume sheet).  Sending both as equal-strength instructions lets
    // the text override the pixels, so do not repeat that stale description.
    const imageSources = [character?.localPath, character?.imageUrl].map(value => String(value || '').trim());
    // Uploaded character images are stored under both static/characters and
    // static/images in existing projects.  The protagonist must be locked to
    // the actual local pixels whenever either source is a local image; relying
    // only on the directory name lets stale extracted costume text override
    // the uploaded protagonist and causes identity swaps in R2V.
    const hasLocalImage = imageSources.some(value => {
        if (!value) return false;
        return isReadableLocalImage(value)
            || /^\/?static[\\/]/i.test(value)
            || path.isAbsolute(value);
    });
    const isManualUpload = imageSources.some(value => /(?:^|[\\/])characters[\\/]/i.test(value));
    if (isManualUpload) {
        return isPrimaryCharacter(character)
            ? 'User-uploaded local master image is the authoritative identity source for this protagonist. Ignore any conflicting textual appearance or costume description. Copy the visible face, hair, body, exact clothing layers, colors, accessories and visible wear from this image in every frame. Never use another character image, scene person or generated replacement for this protagonist.'
            : 'User-uploaded local master image. Ignore any conflicting textual appearance or costume description; copy the visible face, hair, body, exact clothing layers, colors, accessories and visible wear from this image.';
    }
    if (hasLocalImage && isPrimaryCharacter(character)) {
        return 'Local protagonist master image is the authoritative identity source for this character. Copy the visible face, hair, body, exact clothing layers, colors, accessories and visible wear from this image in every frame. Do not replace this protagonist with another character image, scene person or generated identity, and ignore conflicting extracted costume text.';
    }
    const otherNames = knownCharacterNames
        .map(name => String(name || '').trim())
        .filter(name => {
        const normalized = normalizeEntityText(name);
        return normalized && normalized !== ownName;
    });
    const rawAppearance = String(character?.appearance || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const safeAppearance = otherNames.reduce((value, otherName) => (value.replace(new RegExp(escapeRegExp(otherName), 'gi'), '')), rawAppearance);
    return safeAppearance || 'Use only the face, hair, body type, clothing and age shown in this character reference image; do not infer identity from relationship text.';
}
/** Put the bilingual identity key beside the image binding.  H3 indexes
 * pictures in the order supplied by the node, while the storyboard text may
 * use either Chinese display names or English aliases.  Keeping both forms
 * in the same per-picture instruction prevents a visually similar character
 * from inheriting another role. */
function characterIdentityDescriptionWithAliases(character, knownCharacterNames = []) {
    const aliases = characterBindingNames(character).filter(value => normalizeAssetText(value) !== normalizeAssetText(character.name || ''));
    const base = characterIdentityDescription(character, knownCharacterNames);
    return aliases.length
        ? `${base} Canonical character name: ${String(character.name || '').trim()}. English/alternate aliases for this same image only: ${aliases.join(', ')}. Never map these aliases to another Picture.`
        : base;
}
function buildFinalCharacterAssetAuthority(refs = []) {
    return (Array.isArray(refs) ? refs : [])
        .map((item, index) => item.role === 'character' && item.entityName
            ? `FINAL CHARACTER ASSET AUTHORITY: The preceding screenplay or shot text may contain stale clothing, undressing or nudity wording. Ignore that wording for appearance. ${referenceBindingLabel(item, String(item.entityName || 'character'))} must use only the exact face, body, clothing layers, colors, accessories and visible wear shown in <Picture ${index + 1}>; do not undress, tear, remove, recolor, replace or invent clothing. If any text conflicts with this Picture, the character asset image wins.`
            : '')
        .filter(Boolean)
        .join(' ');
}
function extractRoleNames(prompt) {
    const names = [];
    const pattern = /<role>\s*([^<]+?)\s*<\/role>/gi;
    let match;
    while ((match = pattern.exec(prompt))) {
        const name = String(match[1] || '').trim();
        if (name && !names.includes(name))
            names.push(name);
    }
    return names;
}
/** Return the shot's characters in the order the extractor explicitly named
 * them.  Character links are persisted as a set and therefore are not a
 * reliable semantic order; keeping the role-tag order beside the reference
 * images reduces H3 R2V identity swaps for similarly dressed characters. */
export function orderStoryboardCharacters(characters, storyboard) {
    const prompt = [storyboard.videoPrompt, storyboard.action, storyboard.dialogue, storyboard.description].filter(Boolean).join('\n');
    const tagged = extractRoleNames(prompt);
    const used = new Set();
    const ordered = [];
    for (const name of tagged) {
        const index = characters.findIndex((character, candidateIndex) => (!used.has(candidateIndex) && characterNamesMatch(character, name)));
        if (index < 0)
            continue;
        used.add(index);
        ordered.push(characters[index]);
    }
    for (const [index, character] of characters.entries()) {
        if (!used.has(index))
            ordered.push(character);
    }
    return ordered;
}
function extractLocationNames(prompt) {
    const names = [];
    const pattern = /<location>\s*([^<]+?)\s*<\/location>/gi;
    let match;
    while ((match = pattern.exec(prompt))) {
        const name = String(match[1] || '').trim();
        if (name && !names.includes(name))
            names.push(name);
    }
    return names;
}
function parseReferenceImages(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
    }
    catch {
        return [];
    }
}
/** Recover the named character identities used by the previous serial step.
 * The previous tail image can contain people who are not part of the current
 * shot; passing their names lets the local H3 prompt explicitly quarantine
 * those identities instead of asking the model to infer them from pixels. */
function sequenceStepCharacterNames(step) {
    if (!step?.assetRefs)
        return [];
    try {
        const refs = JSON.parse(String(step.assetRefs));
        if (!Array.isArray(refs))
            return [];
        return [...new Set(refs
                .filter(item => String(item?.role || '').trim().toLowerCase() === 'character')
                .map(item => String(item?.entity_name || item?.entityName || item?.canonical_name || item?.canonicalName || item?.name || '').replace(/^角色-/, '').trim())
                .filter(Boolean))];
    }
    catch {
        return [];
    }
}
function sequenceStepCharacterRefs(step) {
    const serialized = step?.assetRefs ?? step?.asset_refs;
    if (!serialized)
        return [];
    try {
        const refs = Array.isArray(serialized) ? serialized : JSON.parse(String(serialized));
        return Array.isArray(refs)
            ? refs.filter(item => String(item?.role || '').trim().toLowerCase() === 'character')
            : [];
    }
    catch {
        return [];
    }
}
/**
 * A previous-tail still is useful when the cast carries across shots, but it
 * becomes an identity contaminant when the current shot replaces every visible
 * character.  Keep the complete previous video for temporal continuation in
 * that case, while omitting the old-cast still from the current R2V picture list.
 */
export function shouldUseLocalContinuityPicture(previous, currentCharacters = []) {
    return false;
}
export function sequenceWaitPollLimit(provider) {
    return String(provider || '').trim().toLowerCase() === 'comfyui'
        ? Number.POSITIVE_INFINITY
        : 660;
}
async function waitForVideoGeneration(id, runId) {
    const [runConfig] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
    const maxAttempts = sequenceWaitPollLimit(runConfig?.provider || '');
    for (let i = 0; i < maxAttempts; i++) {
        const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
        if (!run || run.status === 'cancelled')
            throw new SequenceCancelledError();
        // A failed/completed parent is terminal too. Do not keep waiting on a
        // child generation that can no longer advance the serial run; this is
        // especially important after a worker crash or desktop restart.
        if (['failed', 'completed'].includes(String(run.status || '').toLowerCase()))
            throw new Error(`串行任务已结束（${run.status}），停止等待视频任务`);
        const record = getVideoGeneration(id);
        if (!record)
            throw new Error('视频生成记录不存在');
        if (record.status === 'completed')
            return;
        if (record.status === 'failed')
            throw new Error(record.errorMsg || '谜镜视频生成失败');
        await sleep(5000);
    }
    throw new Error('串行视频生成超时：等待视频任务超过 55 分钟');
}
async function extractContinuityReferenceImage(videoPathOrUrl) {
    let localPath = videoPathOrUrl;
    if (/^https?:\/\//i.test(localPath))
        localPath = await downloadFile(localPath, 'videos', { timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS });
    const absoluteVideo = getAbsolutePath(localPath);
    if (!fs.existsSync(absoluteVideo))
        throw new Error('视频已完成但本地视频文件不存在，无法准备连续参考图');
    const outputDir = path.dirname(absoluteVideo).replace(`${path.sep}videos`, `${path.sep}sequence-frames`);
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `continuity-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    await execFileAsync(getFfmpegBinary(), ['-y', '-sseof', '-1', '-i', absoluteVideo, '-vf', 'reverse', '-frames:v', '1', '-update', '1', output], { timeout: 90_000 });
    const relative = path.relative(path.dirname(getAbsolutePath('static/')), output).split(path.sep).join('/');
    return { localPath: `static/${relative.replace(/^static\//, '')}` };
}
async function extractTailFrame(videoPathOrUrl) {
    let localPath = videoPathOrUrl;
    if (/^https?:\/\//i.test(localPath))
        localPath = await downloadFile(localPath, 'videos', { timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS });
    const absoluteVideo = getAbsolutePath(localPath);
    if (!fs.existsSync(absoluteVideo))
        throw new Error('视频已完成但本地视频文件不存在，无法提取尾帧');
    const outputDir = path.dirname(absoluteVideo).replace(`${path.sep}videos`, `${path.sep}sequence-frames`);
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `tail-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    await execFileAsync(getFfmpegBinary(), ['-y', '-sseof', '-1', '-i', absoluteVideo, '-vf', 'reverse', '-frames:v', '1', '-update', '1', output], { timeout: 90_000 });
    const relative = path.relative(path.dirname(getAbsolutePath('static/')), output).split(path.sep).join('/');
    return { localPath: `static/${relative.replace(/^static\//, '')}` };
}
async function uploadTailFrame(localPath, storyboard, sequence, grokOpenAI = false, comfyUi = false) {
    if (comfyUi)
        return localPath;
    const { ensurePublicImageUrl } = await import('./volc-asset-sync.js');
    try {
        const result = await ensurePublicImageUrl(localPath, `镜头${storyboard.storyboardNumber}-尾帧`, undefined, undefined, grokOpenAI ? {
            preferUguu: true,
            validateResult: true,
            allowedProviders: ['uguu-upload', 'eggfans-image-host'],
        } : undefined);
        return result.url;
    }
    catch (error) {
        if (!grokOpenAI)
            throw error;
        // Grok accepts local images after the normalizer converts them to base64.
        // Keep serial generation usable when both public upload fallbacks are down.
        logTaskWarn('VideoSequence', 'grok-tail-public-upload-fallback-to-base64', {
            storyboardId: storyboard.id,
            error: error instanceof Error ? error.message : String(error),
        });
        return localPath;
    }
}
function getVideoGeneration(id) {
    const [row] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all();
    return row;
}
function assertSequenceActive(runId) {
    const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all();
    if (!run || run.status === 'cancelled')
        throw new SequenceCancelledError();
}
function setRunStatus(runId, status, extra = {}) {
    db.update(schema.videoSequenceRuns).set({ status, updatedAt: now(), ...extra }).where(eq(schema.videoSequenceRuns.id, runId)).run();
}
function markRunFailed(runId, message, storyboardId) {
    setRunStatus(runId, 'failed', { errorMsg: message, currentStoryboardId: storyboardId || null });
    // Keep the failed step in sync with the run.  A worker can fail outside the
    // normal processStep catch (for example while reconciling state or after a
    // database/provider error); in that case the run was marked failed but the
    // UI still saw the step as "waiting" with no explanation.
    const sequence = getVideoSequence(runId);
    const target = sequence?.steps.find(step => {
        if (storyboardId && Number(step.storyboardId) === Number(storyboardId))
            return true;
        return ['preparing', 'submitting', 'processing', 'extracting_tail', 'pending', 'running'].includes(String(step.status || '').toLowerCase());
    });
    if (target && !['completed', 'skipped', 'cancelled', 'failed'].includes(String(target.status || '').toLowerCase())) {
        db.update(schema.videoSequenceSteps)
            .set({ status: 'failed', errorMsg: message, updatedAt: now() })
            .where(eq(schema.videoSequenceSteps.id, target.id))
            .run();
    }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
class SequenceCancelledError extends Error {
    constructor() { super('串行任务已停止'); }
}
