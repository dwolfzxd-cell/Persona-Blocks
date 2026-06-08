import { eventSource, event_types, getThumbnailUrl, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatars, setPersonaDescription, user_avatar } from '../../../personas.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../popup.js';
import { download, parseJsonFile, uuidv4 } from '../../../utils.js';

const MODULE_NAME = 'Persona-Blocks';
const SETTINGS_VERSION = 1;
const DEFAULT_TEMPLATE_ID = 'default-persona';
const DEFAULT_FIELDS = ['Appearance', 'Career', 'Background'];
const DEFAULT_LAYOUT = {
    modalWidth: null,
    modalHeight: null,
    previewWidth: 380,
};
const MIN_MODAL_WIDTH = 720;
const MIN_MODAL_HEIGHT = 520;
const MIN_EDITOR_WIDTH = 280;
const MIN_PREVIEW_WIDTH = 260;
const MAX_PREVIEW_WIDTH = 720;
const COLUMN_RESIZE_WIDTH = 14;
const WORKSPACE_COLUMN_GAP = 6;

const parts = import.meta.url.split('/');
const extensionIndex = parts.indexOf('extensions');
const EXTENSION_PATH = parts.slice(extensionIndex + 1, parts.length - 1).join('/');

let eventsBound = false;
let activeModalRefresh = null;
let settingsLoaded = false;

function makeId(prefix) {
    return `${prefix}-${uuidv4()}`;
}

function asString(value, fallback = '') {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value);
}

function asFiniteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sortByOrder(items) {
    return items.sort((a, b) => Number(a.order) - Number(b.order) || String(a.name || a.title).localeCompare(String(b.name || b.title)));
}

function normalizeOrder(items) {
    sortByOrder(items);
    items.forEach((item, index) => {
        item.order = index;
    });
    return items;
}

function cloneDefaultTemplate() {
    return {
        id: DEFAULT_TEMPLATE_ID,
        name: 'Default Persona',
        fields: DEFAULT_FIELDS.map((name, index) => ({
            id: name.toLowerCase(),
            name,
            order: index,
        })),
    };
}

function cloneDefaultFieldsWithNewIds() {
    return DEFAULT_FIELDS.map((name, index) => ({
        id: makeId('field'),
        name,
        order: index,
    }));
}

function normalizeField(field, index, usedIds) {
    const fallbackId = makeId('field');
    let id = asString(field?.id, fallbackId).trim() || fallbackId;

    if (usedIds.has(id)) {
        id = makeId('field');
    }

    usedIds.add(id);

    return {
        id,
        name: asString(field?.name, `Field ${index + 1}`).trim() || `Field ${index + 1}`,
        order: Number.isFinite(Number(field?.order)) ? Number(field.order) : index,
    };
}

function normalizeTemplate(template, index, usedIds) {
    const defaultTemplate = index === 0 ? cloneDefaultTemplate() : null;
    const fallbackId = defaultTemplate?.id || makeId('template');
    let id = asString(template?.id, fallbackId).trim() || fallbackId;

    if (usedIds.has(id)) {
        id = makeId('template');
    }

    usedIds.add(id);

    const sourceFields = Array.isArray(template?.fields) ? template.fields : defaultTemplate?.fields || [];
    const fieldIds = new Set();
    const fields = sourceFields.map((field, fieldIndex) => normalizeField(field, fieldIndex, fieldIds));

    if (fields.length === 0) {
        fields.push({
            id: makeId('field'),
            name: 'Field',
            order: 0,
        });
    }

    return {
        id,
        name: asString(template?.name, defaultTemplate?.name || `Template ${index + 1}`).trim() || `Template ${index + 1}`,
        fields: normalizeOrder(fields),
    };
}

function normalizeTemplates(templates) {
    const source = Array.isArray(templates) && templates.length > 0 ? templates : [cloneDefaultTemplate()];
    const templateIds = new Set();
    const normalized = source.map((template, index) => normalizeTemplate(template, index, templateIds));

    if (normalized.length === 0) {
        normalized.push(cloneDefaultTemplate());
    }

    return normalized;
}

function normalizeLayout(layout) {
    const source = isPlainObject(layout) ? layout : {};
    const modalWidth = asFiniteNumber(source.modalWidth);
    const modalHeight = asFiniteNumber(source.modalHeight);

    return {
        modalWidth: modalWidth === null ? null : clampNumber(modalWidth, MIN_MODAL_WIDTH, 1600),
        modalHeight: modalHeight === null ? null : clampNumber(modalHeight, MIN_MODAL_HEIGHT, 1200),
        previewWidth: clampNumber(asFiniteNumber(source.previewWidth, DEFAULT_LAYOUT.previewWidth), MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH),
    };
}

function normalizeBlock(block, index, usedIds) {
    const fallbackId = makeId('block');
    let id = asString(block?.id, fallbackId).trim() || fallbackId;

    if (usedIds.has(id)) {
        id = makeId('block');
    }

    usedIds.add(id);

    return {
        id,
        title: asString(block?.title, `Block ${index + 1}`).trim() || `Block ${index + 1}`,
        text: asString(block?.text, ''),
        enabled: block?.enabled !== false,
        order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
    };
}

function normalizePersonaMap(personas, templates) {
    if (!isPlainObject(personas)) {
        return {};
    }

    const templateMap = new Map(templates.map(template => [template.id, template]));
    const fallbackTemplateId = templates[0]?.id || DEFAULT_TEMPLATE_ID;
    const normalized = {};

    for (const [avatarId, personaValue] of Object.entries(personas)) {
        if (!isPlainObject(personaValue)) {
            continue;
        }

        const activeTemplateId = templateMap.has(asString(personaValue.activeTemplateId))
            ? asString(personaValue.activeTemplateId)
            : fallbackTemplateId;
        const templateStates = {};
        const sourceTemplateStates = isPlainObject(personaValue.templates) ? personaValue.templates : {};

        for (const [templateId, templateState] of Object.entries(sourceTemplateStates)) {
            const template = templateMap.get(templateId);

            if (!template || !isPlainObject(templateState)) {
                continue;
            }

            const fieldIds = new Set(template.fields.map(field => field.id));
            const sourceFieldBlocks = isPlainObject(templateState.fieldBlocks) ? templateState.fieldBlocks : {};
            const fieldBlocks = {};

            for (const [fieldId, blocks] of Object.entries(sourceFieldBlocks)) {
                if (!fieldIds.has(fieldId) || !Array.isArray(blocks)) {
                    continue;
                }

                const blockIds = new Set();
                fieldBlocks[fieldId] = normalizeOrder(blocks.map((block, index) => normalizeBlock(block, index, blockIds)));
            }

            templateStates[templateId] = { fieldBlocks };
        }

        normalized[avatarId] = {
            activeTemplateId,
            templates: templateStates,
        };
    }

    return normalized;
}

function loadSettings() {
    if (!isPlainObject(extension_settings[MODULE_NAME])) {
        extension_settings[MODULE_NAME] = {};
    }

    const settings = extension_settings[MODULE_NAME];
    settings.version = SETTINGS_VERSION;
    settings.templates = normalizeTemplates(settings.templates);
    settings.personas = normalizePersonaMap(settings.personas, settings.templates);
    settings.layout = normalizeLayout(settings.layout);
    settingsLoaded = true;

    return settings;
}

function getSettings() {
    if (!settingsLoaded || !isPlainObject(extension_settings[MODULE_NAME])) {
        return loadSettings();
    }

    return extension_settings[MODULE_NAME];
}

function saveExtensionSettings() {
    saveSettingsDebounced();
}

function getTemplate(templateId) {
    const settings = getSettings();
    return settings.templates.find(template => template.id === templateId) || settings.templates[0];
}

function hasTemplate(templateId) {
    return getSettings().templates.some(template => template.id === templateId);
}

function getPersonas() {
    const seen = new Set();
    const personas = Object.entries(power_user.personas || {}).map(([avatar, name]) => {
        seen.add(avatar);
        return {
            avatar,
            name: asString(name, avatar).trim() || avatar,
        };
    });

    if (user_avatar && !seen.has(user_avatar)) {
        personas.push({
            avatar: user_avatar,
            name: asString(power_user.personas?.[user_avatar], 'Current Persona'),
        });
    }

    personas.sort((a, b) => a.name.localeCompare(b.name) || a.avatar.localeCompare(b.avatar));
    return personas;
}

function getInitialAvatarId() {
    const personas = getPersonas();

    if (personas.some(persona => persona.avatar === user_avatar)) {
        return user_avatar;
    }

    return personas[0]?.avatar || '';
}

function getPersonaState(avatarId) {
    const settings = getSettings();

    if (!settings.personas[avatarId]) {
        settings.personas[avatarId] = {
            activeTemplateId: settings.templates[0].id,
            templates: {},
        };
    }

    const state = settings.personas[avatarId];

    if (!settings.templates.some(template => template.id === state.activeTemplateId)) {
        state.activeTemplateId = settings.templates[0].id;
    }

    if (!isPlainObject(state.templates)) {
        state.templates = {};
    }

    return state;
}

function getTemplateState(avatarId, templateId) {
    const personaState = getPersonaState(avatarId);

    if (!isPlainObject(personaState.templates[templateId])) {
        personaState.templates[templateId] = { fieldBlocks: {} };
    }

    if (!isPlainObject(personaState.templates[templateId].fieldBlocks)) {
        personaState.templates[templateId].fieldBlocks = {};
    }

    const template = getTemplate(templateId);

    for (const field of template.fields) {
        if (!Array.isArray(personaState.templates[templateId].fieldBlocks[field.id])) {
            personaState.templates[templateId].fieldBlocks[field.id] = [];
        }
    }

    return personaState.templates[templateId];
}

function getBlocks(avatarId, templateId, fieldId) {
    const templateState = getTemplateState(avatarId, templateId);

    if (!Array.isArray(templateState.fieldBlocks[fieldId])) {
        templateState.fieldBlocks[fieldId] = [];
    }

    return normalizeOrder(templateState.fieldBlocks[fieldId]);
}

function getNativeDescription(avatarId) {
    const descriptor = power_user.persona_descriptions?.[avatarId];
    const activeDescription = avatarId === user_avatar ? power_user.persona_description : '';
    return asString(descriptor?.description ?? activeDescription, '');
}

function composePersonaDescription(avatarId, templateId) {
    const template = getTemplate(templateId);
    const sections = [];

    for (const field of sortByOrder([...template.fields])) {
        const enabledBlocks = getBlocks(avatarId, templateId, field.id)
            .filter(block => block.enabled && block.text.trim());

        if (enabledBlocks.length === 0) {
            continue;
        }

        sections.push(`## ${field.name}\n${enabledBlocks.map(block => block.text.trim()).join('\n\n')}`);
    }

    return sections.join('\n\n').trim();
}

function countEnabledBlocks(avatarId, templateId) {
    const template = getTemplate(templateId);
    return template.fields.reduce((count, field) => {
        return count + getBlocks(avatarId, templateId, field.id).filter(block => block.enabled && block.text.trim()).length;
    }, 0);
}

function addBlock(avatarId, templateId, fieldId, { title = 'New Block', text = '', enabled = true } = {}) {
    const blocks = getBlocks(avatarId, templateId, fieldId);
    blocks.push({
        id: makeId('block'),
        title,
        text,
        enabled,
        order: blocks.length,
    });
    normalizeOrder(blocks);
}

function duplicateBlock(avatarId, templateId, fieldId, blockId) {
    const blocks = getBlocks(avatarId, templateId, fieldId);
    const index = blocks.findIndex(block => block.id === blockId);

    if (index === -1) {
        return;
    }

    const source = blocks[index];
    blocks.splice(index + 1, 0, {
        id: makeId('block'),
        title: `${source.title} Copy`,
        text: source.text,
        enabled: source.enabled,
        order: index + 1,
    });
    normalizeOrder(blocks);
}

function moveItem(items, id, direction) {
    normalizeOrder(items);
    const index = items.findIndex(item => item.id === id);
    const target = index + direction;

    if (index === -1 || target < 0 || target >= items.length) {
        return false;
    }

    const currentOrder = items[index].order;
    items[index].order = items[target].order;
    items[target].order = currentOrder;
    normalizeOrder(items);
    return true;
}

function removeFieldData(templateId, fieldId) {
    const settings = getSettings();

    for (const personaState of Object.values(settings.personas)) {
        const fieldBlocks = personaState.templates?.[templateId]?.fieldBlocks;

        if (fieldBlocks) {
            delete fieldBlocks[fieldId];
        }
    }
}

function countBlocksForField(templateId, fieldId) {
    const settings = getSettings();
    let count = 0;

    for (const personaState of Object.values(settings.personas)) {
        const blocks = personaState.templates?.[templateId]?.fieldBlocks?.[fieldId];
        count += Array.isArray(blocks) ? blocks.length : 0;
    }

    return count;
}

function uniqueTemplateName(baseName) {
    const settings = getSettings();
    const names = new Set(settings.templates.map(template => template.name));
    let candidate = baseName;
    let index = 2;

    while (names.has(candidate)) {
        candidate = `${baseName} ${index}`;
        index++;
    }

    return candidate;
}

function createTemplate(name) {
    const settings = getSettings();
    const template = {
        id: makeId('template'),
        name,
        fields: cloneDefaultFieldsWithNewIds(),
    };

    settings.templates.push(template);
    return template;
}

function duplicateTemplate(sourceTemplateId) {
    const settings = getSettings();
    const source = getTemplate(sourceTemplateId);
    const fieldIdMap = {};
    const template = {
        id: makeId('template'),
        name: uniqueTemplateName(`${source.name} Copy`),
        fields: sortByOrder([...source.fields]).map(field => {
            const newFieldId = makeId('field');
            fieldIdMap[field.id] = newFieldId;
            return {
                id: newFieldId,
                name: field.name,
                order: field.order,
            };
        }),
    };

    settings.templates.push(template);

    for (const personaState of Object.values(settings.personas)) {
        const sourceState = personaState.templates?.[sourceTemplateId];

        if (!sourceState) {
            continue;
        }

        const copiedFieldBlocks = {};

        for (const [sourceFieldId, blocks] of Object.entries(sourceState.fieldBlocks || {})) {
            const newFieldId = fieldIdMap[sourceFieldId];

            if (!newFieldId || !Array.isArray(blocks)) {
                continue;
            }

            copiedFieldBlocks[newFieldId] = blocks.map(block => ({
                ...structuredClone(block),
                id: makeId('block'),
            }));
        }

        personaState.templates[template.id] = { fieldBlocks: copiedFieldBlocks };
    }

    return template;
}

function deleteTemplate(templateId) {
    const settings = getSettings();

    if (settings.templates.length <= 1) {
        toastr.warning('At least one template is required.');
        return null;
    }

    settings.templates = settings.templates.filter(template => template.id !== templateId);

    for (const personaState of Object.values(settings.personas)) {
        delete personaState.templates?.[templateId];

        if (personaState.activeTemplateId === templateId) {
            personaState.activeTemplateId = settings.templates[0].id;
        }
    }

    return settings.templates[0];
}

function parseDescriptionSections(description, template) {
    const matches = [...description.matchAll(/^##\s+(.+?)\s*$/gm)];

    if (matches.length === 0) {
        return [{
            fieldId: template.fields[0].id,
            title: 'Imported Description',
            text: description.trim(),
        }];
    }

    const sections = [];

    for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        const next = matches[index + 1];
        const heading = match[1].trim();
        const start = match.index + match[0].length;
        const end = next ? next.index : description.length;
        const text = description.slice(start, end).trim();

        if (!text) {
            continue;
        }

        const field = template.fields.find(item => item.name.localeCompare(heading, undefined, { sensitivity: 'accent' }) === 0)
            || template.fields[0];

        sections.push({
            fieldId: field.id,
            title: heading,
            text,
        });
    }

    return sections;
}

function importCurrentDescription(avatarId, templateId) {
    const description = getNativeDescription(avatarId).trim();

    if (!description) {
        toastr.warning('The selected persona has no description to import.');
        return false;
    }

    const template = getTemplate(templateId);
    const sections = parseDescriptionSections(description, template);

    for (const section of sections) {
        addBlock(avatarId, templateId, section.fieldId, {
            title: section.title,
            text: section.text,
            enabled: true,
        });
    }

    saveExtensionSettings();
    toastr.success('Imported current persona description.');
    return true;
}

function exportSettings() {
    const payload = {
        name: MODULE_NAME,
        version: SETTINGS_VERSION,
        exportedAt: new Date().toISOString(),
        settings: getSettings(),
    };
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    download(blob, `persona-blocks_${timestamp}.json`, 'application/json');
}

function getImportedSettings(data) {
    const source = isPlainObject(data?.settings) ? data.settings : data;

    if (!isPlainObject(source) || !Array.isArray(source.templates) || !isPlainObject(source.personas)) {
        throw new Error('Invalid Persona Blocks export.');
    }

    const imported = {
        version: SETTINGS_VERSION,
        templates: source.templates,
        personas: source.personas,
        layout: source.layout,
    };

    const normalizedTemplates = normalizeTemplates(imported.templates);

    return {
        version: SETTINGS_VERSION,
        templates: normalizedTemplates,
        personas: normalizePersonaMap(imported.personas, normalizedTemplates),
        layout: normalizeLayout(imported.layout),
    };
}

async function importSettingsFromFile(fileInput, refresh) {
    const file = fileInput.files?.[0];

    if (!file) {
        return;
    }

    try {
        const data = await parseJsonFile(file);
        const importedSettings = getImportedSettings(data);
        const confirm = await Popup.show.confirm('Import Persona Blocks', 'Replace all Persona Blocks templates and blocks with the selected file?');

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        extension_settings[MODULE_NAME] = importedSettings;
        loadSettings();
        saveExtensionSettings();
        refresh();
        toastr.success('Persona Blocks imported.');
    } catch (error) {
        console.error('[Persona Blocks] Import failed:', error);
        toastr.warning('Invalid Persona Blocks export file.');
    } finally {
        fileInput.value = '';
    }
}

async function refreshNativePersonaList(avatarId) {
    try {
        await getUserAvatars(true, avatarId);
    } catch (error) {
        console.warn('[Persona Blocks] Failed to refresh native persona list:', error);
    }
}

async function applyComposedDescription(avatarId, templateId) {
    const composed = composePersonaDescription(avatarId, templateId);

    if (!composed.trim()) {
        const confirm = await Popup.show.confirm('Clear Persona Description', 'The composed preview is empty. Clear this persona description?');

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            return false;
        }
    }

    const descriptor = power_user.persona_descriptions?.[avatarId] || {};
    power_user.persona_descriptions[avatarId] = {
        ...descriptor,
        description: composed,
        position: descriptor.position ?? power_user.persona_description_position ?? 0,
        depth: descriptor.depth ?? power_user.persona_description_depth ?? 2,
        role: descriptor.role ?? power_user.persona_description_role ?? 0,
        lorebook: descriptor.lorebook ?? '',
        title: descriptor.title ?? '',
    };

    if (avatarId === user_avatar) {
        power_user.persona_description = composed;
        setPersonaDescription();
    }

    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
    await refreshNativePersonaList(avatarId);
    toastr.success('Persona Description updated.');
    return true;
}

function renderPersonaSelect(dlg, selectedAvatarId) {
    const personas = getPersonas();
    const select = dlg.find('#pb_persona_select');
    select.empty();

    for (const persona of personas) {
        select.append($('<option></option>').val(persona.avatar).text(persona.name));
    }

    select.val(selectedAvatarId);

    const selected = personas.find(persona => persona.avatar === selectedAvatarId);
    dlg.find('#pb_selected_persona_name').text(selected?.name || selectedAvatarId || 'No Persona');
    dlg.find('#pb_selected_persona_avatar').attr('src', selectedAvatarId ? getThumbnailUrl('persona', selectedAvatarId) : '');
}

function renderTemplateSelect(dlg, selectedTemplateId) {
    const settings = getSettings();
    const select = dlg.find('#pb_template_select');
    select.empty();

    for (const template of settings.templates) {
        select.append($('<option></option>').val(template.id).text(template.name));
    }

    select.val(selectedTemplateId);
    dlg.find('#pb_template_delete').prop('disabled', settings.templates.length <= 1).toggleClass('disabled', settings.templates.length <= 1);
}

function renderPreview(dlg, avatarId, templateId) {
    const preview = composePersonaDescription(avatarId, templateId);
    dlg.find('#pb_preview_text').val(preview);
    const count = countEnabledBlocks(avatarId, templateId);
    const characters = preview.length;
    dlg.find('#pb_preview_meta').text(`${count} active block${count === 1 ? '' : 's'} · ${characters} character${characters === 1 ? '' : 's'}`);
}

function makeIconButton(icon, title) {
    return $('<button type="button" class="menu_button"></button>')
        .attr('title', title)
        .append($('<i></i>').addClass(`fa-solid ${icon}`));
}

function renderBlock(dlg, block, avatarId, templateId, fieldId, refresh) {
    const blockElement = $('<div class="pb-block"></div>').attr('data-block-id', block.id);
    const header = $('<div class="pb-block-header"></div>');
    const titleWrap = $('<div class="pb-block-title-wrap"></div>');
    const enabled = $('<input type="checkbox" class="pb-block-enabled">').prop('checked', block.enabled).attr('title', 'Enable Block');
    const title = $('<input type="text" class="text_pole pb-block-title">').val(block.title).attr('aria-label', 'Block title');
    const actions = $('<div class="pb-block-actions"></div>');
    const moveUp = makeIconButton('fa-arrow-up', 'Move Block Up');
    const moveDown = makeIconButton('fa-arrow-down', 'Move Block Down');
    const duplicate = makeIconButton('fa-clone', 'Duplicate Block');
    const remove = makeIconButton('fa-trash-can', 'Delete Block');
    const text = $('<textarea class="text_pole pb-block-text" rows="4"></textarea>').val(block.text).attr('aria-label', 'Block text');

    enabled.on('change', () => {
        block.enabled = enabled.prop('checked');
        saveExtensionSettings();
        renderPreview(dlg, avatarId, templateId);
    });

    title.on('input', () => {
        block.title = String(title.val());
        saveExtensionSettings();
    });

    text.on('input', () => {
        block.text = String(text.val());
        saveExtensionSettings();
        renderPreview(dlg, avatarId, templateId);
    });

    moveUp.on('click', () => {
        moveItem(getBlocks(avatarId, templateId, fieldId), block.id, -1);
        saveExtensionSettings();
        refresh();
    });

    moveDown.on('click', () => {
        moveItem(getBlocks(avatarId, templateId, fieldId), block.id, 1);
        saveExtensionSettings();
        refresh();
    });

    duplicate.on('click', () => {
        duplicateBlock(avatarId, templateId, fieldId, block.id);
        saveExtensionSettings();
        refresh();
    });

    remove.on('click', async () => {
        if (block.text.trim()) {
            const confirm = await Popup.show.confirm('Delete Block', block.title);

            if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }
        }

        const blocks = getBlocks(avatarId, templateId, fieldId);
        const index = blocks.findIndex(item => item.id === block.id);

        if (index !== -1) {
            blocks.splice(index, 1);
            normalizeOrder(blocks);
            saveExtensionSettings();
            refresh();
        }
    });

    actions.append(moveUp, moveDown, duplicate, remove);
    titleWrap.append(enabled, title);
    header.append(titleWrap, actions);
    blockElement.append(header, text);
    return blockElement;
}

function renderFields(dlg, avatarId, templateId, refresh) {
    const template = getTemplate(templateId);
    const container = dlg.find('#pb_fields');
    container.empty();

    for (const field of sortByOrder([...template.fields])) {
        const fieldElement = $('<div class="pb-field"></div>').attr('data-field-id', field.id);
        const header = $('<div class="pb-field-header"></div>');
        const name = $('<div class="pb-field-name"></div>')
            .append($('<i class="fa-solid fa-layer-group"></i>'))
            .append($('<span></span>').text(field.name));
        const actions = $('<div class="pb-field-actions"></div>');
        const add = makeIconButton('fa-plus', 'Add Block');
        const rename = makeIconButton('fa-pencil', 'Rename Field');
        const moveUp = makeIconButton('fa-arrow-up', 'Move Field Up');
        const moveDown = makeIconButton('fa-arrow-down', 'Move Field Down');
        const remove = makeIconButton('fa-trash-can', 'Delete Field');
        const blocksContainer = $('<div class="pb-blocks"></div>');
        const blocks = getBlocks(avatarId, templateId, field.id);

        add.on('click', () => {
            addBlock(avatarId, templateId, field.id);
            saveExtensionSettings();
            refresh();
        });

        rename.on('click', async () => {
            const newName = await Popup.show.input('Rename Field', '', field.name);

            if (!newName?.trim()) {
                return;
            }

            field.name = newName.trim();
            saveExtensionSettings();
            refresh();
        });

        moveUp.on('click', () => {
            moveItem(template.fields, field.id, -1);
            saveExtensionSettings();
            refresh();
        });

        moveDown.on('click', () => {
            moveItem(template.fields, field.id, 1);
            saveExtensionSettings();
            refresh();
        });

        remove.on('click', async () => {
            if (template.fields.length <= 1) {
                toastr.warning('At least one field is required.');
                return;
            }

            const blockCount = countBlocksForField(templateId, field.id);

            if (blockCount > 0) {
                const confirm = await Popup.show.confirm('Delete Field', `Delete "${field.name}" and ${blockCount} block${blockCount === 1 ? '' : 's'}?`);

                if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
                    return;
                }
            }

            template.fields = template.fields.filter(item => item.id !== field.id);
            normalizeOrder(template.fields);
            removeFieldData(templateId, field.id);
            saveExtensionSettings();
            refresh();
        });

        actions.append(add, rename, moveUp, moveDown, remove);
        header.append(name, actions);

        if (blocks.length === 0) {
            blocksContainer.append($('<div class="pb-empty"></div>').text('No blocks'));
        } else {
            for (const block of blocks) {
                blocksContainer.append(renderBlock(dlg, block, avatarId, templateId, field.id, refresh));
            }
        }

        fieldElement.append(header, blocksContainer);
        container.append(fieldElement);
    }
}

function getModalSizeLimits() {
    const horizontalMargin = window.innerWidth <= 900 ? 32 : 96;
    const maxWidth = Math.max(360, window.innerWidth - horizontalMargin);
    const maxHeight = Math.max(320, window.innerHeight - 120);

    return {
        minWidth: Math.min(MIN_MODAL_WIDTH, maxWidth),
        maxWidth,
        minHeight: Math.min(MIN_MODAL_HEIGHT, maxHeight),
        maxHeight,
    };
}

function getPreviewWidthLimits(workspace) {
    const workspaceWidth = workspace?.getBoundingClientRect().width || 0;
    const availableMax = workspaceWidth - MIN_EDITOR_WIDTH - COLUMN_RESIZE_WIDTH - (WORKSPACE_COLUMN_GAP * 2);
    const maxWidth = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, availableMax));

    return {
        minWidth: MIN_PREVIEW_WIDTH,
        maxWidth,
    };
}

function applyPreviewWidth(dlg, width, { persist = false } = {}) {
    const workspace = dlg.find('.pb-workspace').get(0);
    const splitter = dlg.find('#pb_column_resize').get(0);

    if (!workspace) {
        return;
    }

    const layout = getSettings().layout;
    const limits = getPreviewWidthLimits(workspace);
    const nextWidth = Math.round(clampNumber(width ?? layout.previewWidth, limits.minWidth, limits.maxWidth));

    layout.previewWidth = nextWidth;
    workspace.style.setProperty('--pb-preview-width', `${nextWidth}px`);

    if (splitter) {
        splitter.setAttribute('aria-valuemin', String(Math.round(limits.minWidth)));
        splitter.setAttribute('aria-valuemax', String(Math.round(limits.maxWidth)));
        splitter.setAttribute('aria-valuenow', String(nextWidth));
    }

    if (persist) {
        saveExtensionSettings();
    }
}

function applySavedModalSize(dlg) {
    const modal = dlg.get(0);

    if (!modal) {
        return;
    }

    const layout = getSettings().layout;
    const limits = getModalSizeLimits();

    if (layout.modalWidth !== null) {
        modal.style.width = `${Math.round(clampNumber(layout.modalWidth, limits.minWidth, limits.maxWidth))}px`;
    }

    if (layout.modalHeight !== null) {
        modal.style.height = `${Math.round(clampNumber(layout.modalHeight, limits.minHeight, limits.maxHeight))}px`;
    }
}

function addLayoutHandlers(dlg) {
    const modal = dlg.get(0);
    const workspace = dlg.find('.pb-workspace').get(0);
    const splitter = dlg.find('#pb_column_resize').get(0);
    const cleanups = [];
    let resizeFrame = null;

    if (!modal || !workspace || !splitter) {
        return () => {};
    }

    const addListener = (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        cleanups.push(() => target.removeEventListener(event, handler, options));
    };

    const syncLayout = () => {
        applyPreviewWidth(dlg, getSettings().layout.previewWidth);
    };

    const persistModalSize = () => {
        const limits = getModalSizeLimits();
        const rect = modal.getBoundingClientRect();
        const layout = getSettings().layout;
        const nextWidth = Math.round(clampNumber(rect.width, limits.minWidth, limits.maxWidth));
        const nextHeight = Math.round(clampNumber(rect.height, limits.minHeight, limits.maxHeight));

        if (layout.modalWidth !== nextWidth || layout.modalHeight !== nextHeight) {
            layout.modalWidth = nextWidth;
            layout.modalHeight = nextHeight;
            saveExtensionSettings();
        }
    };

    applySavedModalSize(dlg);
    requestAnimationFrame(syncLayout);

    let observerReady = false;

    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
            if (resizeFrame !== null) {
                cancelAnimationFrame(resizeFrame);
            }

            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                syncLayout();

                if (!observerReady) {
                    observerReady = true;
                    return;
                }

                persistModalSize();
            });
        });

        observer.observe(modal);
        cleanups.push(() => observer.disconnect());
    }

    let dragging = false;
    let dragWorkspaceRect = null;

    const resizeFromClientX = (clientX) => {
        if (!dragWorkspaceRect) {
            return;
        }

        applyPreviewWidth(dlg, dragWorkspaceRect.right - clientX);
    };

    addListener(splitter, 'pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        dragging = true;
        dragWorkspaceRect = workspace.getBoundingClientRect();
        splitter.setPointerCapture(event.pointerId);
        document.body.classList.add('pb-column-resizing');
        event.preventDefault();
    });

    addListener(splitter, 'pointermove', (event) => {
        if (!dragging) {
            return;
        }

        resizeFromClientX(event.clientX);
    });

    const stopDragging = (event) => {
        if (!dragging) {
            return;
        }

        dragging = false;
        dragWorkspaceRect = null;
        document.body.classList.remove('pb-column-resizing');

        if (splitter.hasPointerCapture?.(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }

        saveExtensionSettings();
    };

    addListener(splitter, 'pointerup', stopDragging);
    addListener(splitter, 'pointercancel', stopDragging);

    addListener(splitter, 'keydown', (event) => {
        const currentWidth = getSettings().layout.previewWidth;
        let nextWidth = currentWidth;

        if (event.key === 'ArrowLeft') {
            nextWidth = currentWidth + 24;
        } else if (event.key === 'ArrowRight') {
            nextWidth = currentWidth - 24;
        } else if (event.key === 'Home') {
            nextWidth = MIN_PREVIEW_WIDTH;
        } else if (event.key === 'End') {
            nextWidth = MAX_PREVIEW_WIDTH;
        } else {
            return;
        }

        event.preventDefault();
        applyPreviewWidth(dlg, nextWidth, { persist: true });
    });

    addListener(window, 'resize', () => {
        applySavedModalSize(dlg);
        syncLayout();
    });

    return () => {
        if (resizeFrame !== null) {
            cancelAnimationFrame(resizeFrame);
        }

        document.body.classList.remove('pb-column-resizing');
        cleanups.forEach(cleanup => cleanup());
    };
}

function addStaticHandlers(dlg, getSelection, setSelection, refresh) {
    dlg.find('#pb_persona_select').on('change', function () {
        const avatarId = String($(this).val());
        const personaState = getPersonaState(avatarId);
        setSelection({ avatarId, templateId: personaState.activeTemplateId });
        refresh();
    });

    dlg.find('#pb_template_select').on('change', function () {
        const { avatarId } = getSelection();
        const templateId = String($(this).val());
        getPersonaState(avatarId).activeTemplateId = templateId;
        setSelection({ templateId });
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_template_new').on('click', async () => {
        const name = await Popup.show.input('New Template', '', 'New Template');

        if (!name?.trim()) {
            return;
        }

        const template = createTemplate(name.trim());
        const { avatarId } = getSelection();
        getPersonaState(avatarId).activeTemplateId = template.id;
        setSelection({ templateId: template.id });
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_template_rename').on('click', async () => {
        const { templateId } = getSelection();
        const template = getTemplate(templateId);
        const name = await Popup.show.input('Rename Template', '', template.name);

        if (!name?.trim()) {
            return;
        }

        template.name = name.trim();
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_template_duplicate').on('click', () => {
        const { avatarId, templateId } = getSelection();
        const template = duplicateTemplate(templateId);
        getPersonaState(avatarId).activeTemplateId = template.id;
        setSelection({ templateId: template.id });
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_template_delete').on('click', async () => {
        const { avatarId, templateId } = getSelection();
        const template = getTemplate(templateId);
        const confirm = await Popup.show.confirm('Delete Template', template.name);

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const nextTemplate = deleteTemplate(templateId);

        if (!nextTemplate) {
            return;
        }

        getPersonaState(avatarId).activeTemplateId = nextTemplate.id;
        setSelection({ templateId: nextTemplate.id });
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_field_add').on('click', async () => {
        const { templateId } = getSelection();
        const template = getTemplate(templateId);
        const name = await Popup.show.input('Add Field', '', 'New Field');

        if (!name?.trim()) {
            return;
        }

        template.fields.push({
            id: makeId('field'),
            name: name.trim(),
            order: template.fields.length,
        });
        normalizeOrder(template.fields);
        saveExtensionSettings();
        refresh();
    });

    dlg.find('#pb_import_current').on('click', () => {
        const { avatarId, templateId } = getSelection();

        if (importCurrentDescription(avatarId, templateId)) {
            refresh();
        }
    });

    dlg.find('#pb_apply').on('click', async () => {
        const { avatarId, templateId } = getSelection();
        await applyComposedDescription(avatarId, templateId);
        renderPreview(dlg, avatarId, templateId);
    });

    dlg.find('#pb_export').on('click', exportSettings);
    dlg.find('#pb_import_button').on('click', () => dlg.find('#pb_import_file').trigger('click'));
    dlg.find('#pb_import_file').on('change', function () {
        importSettingsFromFile(this, refresh);
    });
}

async function showPersonaBlocksModal() {
    loadSettings();

    if (getPersonas().length === 0) {
        toastr.warning('No personas found.');
        return;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'modal');
    const dlg = $(html);
    let selectedAvatarId = getInitialAvatarId();
    let selectedTemplateId = getPersonaState(selectedAvatarId).activeTemplateId;

    const getSelection = () => ({
        avatarId: selectedAvatarId,
        templateId: selectedTemplateId,
    });

    const setSelection = ({ avatarId = selectedAvatarId, templateId = selectedTemplateId }) => {
        selectedAvatarId = avatarId;
        selectedTemplateId = templateId;
    };

    const refresh = () => {
        loadSettings();
        const personas = getPersonas();

        if (!personas.some(persona => persona.avatar === selectedAvatarId)) {
            selectedAvatarId = getInitialAvatarId();
        }

        const personaState = getPersonaState(selectedAvatarId);

        if (!hasTemplate(selectedTemplateId)) {
            selectedTemplateId = personaState.activeTemplateId;
        }

        if (!hasTemplate(selectedTemplateId)) {
            selectedTemplateId = getSettings().templates[0].id;
        }

        personaState.activeTemplateId = selectedTemplateId;
        renderPersonaSelect(dlg, selectedAvatarId);
        renderTemplateSelect(dlg, selectedTemplateId);
        renderFields(dlg, selectedAvatarId, selectedTemplateId, refresh);
        renderPreview(dlg, selectedAvatarId, selectedTemplateId);
    };

    addStaticHandlers(dlg, getSelection, setSelection, refresh);
    activeModalRefresh = refresh;
    refresh();
    let cleanupLayoutHandlers = () => {};

    try {
        const popupPromise = callGenericPopup(dlg, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: false,
            cancelButton: 'Close',
            allowVerticalScrolling: true,
        });
        cleanupLayoutHandlers = addLayoutHandlers(dlg);
        await popupPromise;
    } finally {
        cleanupLayoutHandlers();
        activeModalRefresh = null;
    }
}

function addLauncher() {
    const menu = $('#extensionsMenu');

    if (!menu.length) {
        setTimeout(addLauncher, 200);
        return;
    }

    if ($('#persona_blocks').length) {
        return;
    }

    let container = $('#persona_blocks_wand_container');

    if (!container.length) {
        container = $('<div id="persona_blocks_wand_container" class="extension_container"></div>');
        menu.append(container);
    }

    const button = $('<div id="persona_blocks" class="list-group-item flex-container flexGap5"></div>');
    button.append($('<div class="fa-solid fa-id-card extensionsMenuExtensionButton"></div>'));
    button.append($('<span></span>').text('Persona Blocks'));
    button.on('click', showPersonaBlocksModal);
    container.append(button);
}

function bindPersonaEvents() {
    if (eventsBound) {
        return;
    }

    eventsBound = true;

    eventSource.on(event_types.PERSONA_DELETED, ({ avatarId } = {}) => {
        if (!avatarId) {
            return;
        }

        const settings = getSettings();

        if (settings.personas[avatarId]) {
            delete settings.personas[avatarId];
            saveExtensionSettings();
        }

        activeModalRefresh?.();
    });

    eventSource.on(event_types.PERSONA_CREATED, ({ avatarId, duplicatedFromAvatarId } = {}) => {
        if (!avatarId) {
            return;
        }

        const settings = getSettings();

        if (duplicatedFromAvatarId && settings.personas[duplicatedFromAvatarId]) {
            settings.personas[avatarId] = structuredClone(settings.personas[duplicatedFromAvatarId]);
            saveExtensionSettings();
        }

        activeModalRefresh?.();
    });

    eventSource.on(event_types.PERSONA_RENAMED, () => activeModalRefresh?.());
    eventSource.on(event_types.PERSONA_CHANGED, () => activeModalRefresh?.());
}

export function init() {
    loadSettings();
    addLauncher();
    bindPersonaEvents();
}
