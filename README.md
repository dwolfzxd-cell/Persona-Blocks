# Persona Blocks

Persona Blocks is a local SillyTavern extension for building persona descriptions out of reusable text blocks.

SillyTavern stores a persona as the user's character, with one native `Persona Description` field. This extension keeps that native field intact, but gives you a modal where you can draft, toggle, mix, and reuse sections before applying the final composed text.

## What It Does

- Opens from the extensions wand menu as `Persona Blocks`.
- Lists your existing SillyTavern personas in a dropdown.
- Uses templates to define fields such as `Appearance`, `Career`, and `Background`.
- Lets each persona keep multiple blocks per field.
- Allows multiple blocks to be enabled at the same time.
- Shows a live preview of the composed persona description.
- Lets you resize the modal and drag the divider between the editor and preview columns.
- Writes to SillyTavern's native `Persona Description` only when you click `Apply to Persona Description`.

Block titles are only for organizing the modal. They are not included in the composed persona text.

## Basic Use

1. Open the extensions wand menu.
2. Click `Persona Blocks`.
3. Pick a persona.
4. Pick a template.
5. Add blocks under the fields you want to use.
6. Toggle blocks on or off.
7. Check the preview.
8. Click `Apply to Persona Description` when you want to update the real SillyTavern persona description.

You can drag the modal's lower-right resize handle to change its size, and drag the vertical divider between `Fields` and `Preview` to rebalance the columns.

The preview is composed in template field order:

```text
## Appearance
Enabled appearance block text.

## Career
Enabled career block text.

## Background
Enabled background block text.
```

## Templates

The default template is `Default Persona`, with these fields:

- `Appearance`
- `Career`
- `Background`

You can create, rename, duplicate, and delete templates. You can also add, rename, reorder, and delete fields inside a template.

At least one template and one field are always required.

## Importing Existing Descriptions

Use `Import Current Description` to pull the selected persona's current native description into Persona Blocks.

If the description already uses headings like `## Appearance`, the extension tries to place each section into a matching field. If there are no headings, it creates one starter block in the first field.

## Data And Backups

Persona Blocks stores its data in:

```js
extension_settings['Persona-Blocks']
```

That means the block data is separate from SillyTavern's native persona backup. Use the export/import buttons in the Persona Blocks modal when you want to back up or move Persona Blocks data.

The same settings also store modal layout preferences, such as the modal size and preview column width.

The extension listens for persona events:

- Deleted personas have their Persona Blocks data removed.
- Duplicated personas copy the original persona's blocks.
- Renamed or changed personas refresh the modal if it is open.

## Files

```text
public/scripts/extensions/third-party/Persona-Blocks/
  index.js
  manifest.json
  modal.html
  style.css
  README.md
```

This is a local third-party extension. The SillyTavern repo ignores `public/scripts/extensions/third-party`, so these files may not appear in normal `git status` output.
