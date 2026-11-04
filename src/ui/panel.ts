import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { ADJUSTMENTS, type Adjustment, type Aspect, type Edit } from '../schema'
import { currentPhoto, hasAutoSettings, type AppState } from '../state'
import { histogramView } from './histogram'

const GROUPS = ['White balance', 'Tone', 'Presence'] as const
const ASPECTS: [Aspect, string][] = [
  ['original', 'Original'],
  ['free', 'Free'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:2', '3:2'],
  ['16:9', '16:9']
]

export function panel(state: AppState) {
  const photo = currentPhoto(state)
  if (!photo) return html`<aside class="panel"></aside>`

  const edit = photo.edit
  return html`
    <aside class="panel">
      ${histogramView(state.editor.histogram)}
      <div class="panel-actions">
        <button
          class="button primary"
          data-action="auto"
          title="Automatic exposure, contrast and colour intensity"
          ?disabled=${hasAutoSettings(state)}
        >
          <i class="icon-wand-sparkles"></i> Auto
        </button>
        <button
          class="icon-button"
          data-action="copy-settings"
          title="Copy settings (Ctrl+Shift+C)"
        >
          <i class="icon-copy"></i>
        </button>
        <button
          class="icon-button"
          data-action="paste-settings"
          title="Paste settings (Ctrl+Shift+V)"
          ?disabled=${!state.clipboard}
        >
          <i class="icon-clipboard-paste"></i>
        </button>
        <button
          class="icon-button"
          data-action="reset-all"
          title="Reset all adjustments"
        >
          <i class="icon-refresh-ccw"></i>
        </button>
      </div>
      ${state.mode === 'crop' ? geometry(state, edit) : nothing}
      ${GROUPS.map(group => sliderGroup(state, group, edit))}
    </aside>
  `
}

function sliderGroup(
  state: AppState, group: Adjustment['group'], edit: Edit
) {
  const adjustments = ADJUSTMENTS.filter(a => a.group === group)
  const picking = state.editor.tool === 'eyedropper'

  return html`
    <section class="panel-group">
      <header class="panel-heading">
        <span>${group}</span>
        ${group === 'White balance'
          ? html`
            <span class="tool-row">
              <button
                class="icon-button"
                data-action="auto-wb"
                title="Remove a colour cast automatically"
              >
                <i class="icon-wand-sparkles"></i>
              </button>
              <button
                class=${classMap({ 'icon-button': true, on: picking })}
                data-action="eyedropper"
                title="Click something that should be grey"
              >
                <i class="icon-pipette"></i>
              </button>
            </span>
          `
          : nothing}
      </header>
      ${adjustments.map(a => slider(a, edit[a.key]))}
    </section>
  `
}

function slider(a: Adjustment, value: number) {
  const shown = a.step < 1 ? value.toFixed(a.step < 0.1 ? 2 : 1) : value

  return html`
    <label
      class="slider"
      data-dblclick="reset-slider"
      data-key=${a.key}
      title="Double-click to reset"
    >
      <span class="slider-label">${a.label}</span>
      <output class="slider-value">${shown}</output>
      <input
        type="range"
        class="slider-input slider-${a.key}"
        min=${a.min}
        max=${a.max}
        step=${a.step}
        .value=${live(String(value))}
        data-input="slider"
        data-change="slider-end"
        data-key=${a.key}
      >
    </label>
  `
}

function geometry(state: AppState, edit: Edit) {
  const angle = ADJUSTMENTS.find(a => a.key === 'angle')!
  const levelling = state.editor.tool === 'horizon'

  return html`
    <section class="panel-group">
      <header class="panel-heading">
        <span>Crop and straighten</span>
        <button class="button" data-action="crop-done">Done</button>
      </header>
      <div class="chips">
        ${ASPECTS.map(([value, label]) => html`
          <button
            class=${classMap({ chip: true, on: edit.aspect === value })}
            data-action="aspect"
            data-aspect=${value}
          >
            ${label}
          </button>
        `)}
      </div>
      <div class="tool-row">
        <button
          class="icon-button"
          data-action="swap-crop"
          title="Portrait or landscape"
        >
          <i class="icon-rectangle-vertical"></i>
        </button>
        <button
          class="icon-button"
          data-action="rotate"
          data-turn="-90"
          title="Rotate left"
        >
          <i class="icon-rotate-ccw"></i>
        </button>
        <button
          class="icon-button"
          data-action="rotate"
          data-turn="90"
          title="Rotate right"
        >
          <i class="icon-rotate-cw"></i>
        </button>
        <button class="icon-button" data-action="flip" title="Flip">
          <i class="icon-flip-horizontal-2"></i>
        </button>
        <button
          class=${classMap({ 'icon-button': true, on: levelling })}
          data-action="horizon"
          title="Draw along the horizon to level it"
        >
          <i class="icon-ruler"></i>
        </button>
        <button
          class="icon-button"
          data-action="reset-crop"
          title="Reset crop and angle"
        >
          <i class="icon-eraser"></i>
        </button>
      </div>
      ${slider(angle, edit.angle)}
    </section>
  `
}
