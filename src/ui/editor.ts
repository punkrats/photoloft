import { html, nothing, svg } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { repeat } from 'lit-html/directives/repeat.js'
import { styleMap } from 'lit-html/directives/style-map.js'
import { formatDuration } from '../format'
import { effectiveCrop, type Handle } from '../geometry'
import type { Library } from '../library'
import { cropBox, stageLayout, type StageLayout } from '../stage-layout'
import { currentPhoto, viewIds, type AppState } from '../state'
import { historyButtons } from './library'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const FILMSTRIP_REACH = 40

export function editor(state: AppState, lib: Library) {
  const photo = currentPhoto(state)
  const layout = stageLayout(state)
  const loading = state.editor.loading !== null ||
    state.editor.loaded !== state.current
  const vars = layout
    ? { '--w': `${layout.css.w}px`, '--h': `${layout.css.h}px` }
    : {}
  const stageClasses = {
    stage: true,
    zoom: state.zoom && state.mode === 'edit',
    loading,
    picking: state.editor.tool !== 'none'
  }

  return html`
    <section class="editor">
      ${photo ? bar(state, lib, photo.id) : nothing}
      <div class=${classMap(stageClasses)} data-stage>
        <div class="stage-frame" style=${styleMap(vars)} data-frame>
          <canvas class="stage-canvas"></canvas>
          ${loading && photo ? placeholder(state, photo.id) : nothing}
          ${state.mode === 'crop' && layout
            ? cropOverlay(state, layout)
            : nothing}
          ${state.before
            ? html`<span class="stage-badge">Before</span>`
            : nothing}
        </div>
      </div>
      ${photo?.video ? transport(state, photo.video.duration) : nothing}
      ${photo ? filmstrip(state, lib) : nothing}
    </section>
  `
}

function bar(state: AppState, lib: Library, id: string) {
  const photo = lib.photos[id]
  const ids = viewIds(state)
  const position = `${ids.indexOf(id) + 1} / ${ids.length}`
  const renaming = state.renaming?.kind === 'photo'

  return html`
    <header class="editor-bar">
      <button
        class="icon-button"
        data-action="close-editor"
        title="Back to the grid (Esc)"
      >
        <i class="icon-arrow-left"></i>
      </button>
      ${renaming
        ? html`
          <input
            class="rename-input editor-name"
            data-rename="photo"
            data-id=${id}
            .value=${live(photo.name)}
          >
        `
        : html`
          <h2
            class="editor-name"
            data-dblclick="rename-photo"
            title="Double-click to rename"
          >
            ${photo.name}
          </h2>
        `}
      <span class="toolbar-count">${position}</span>
      <span class="toolbar-gap"></span>
      <span class="editor-hint">Space or Esc closes, Enter edits</span>
      ${toggle(photo.starred, 'star', 'icon-star', 'Star to keep (S)')}
      <span class="editor-tools">
        ${toggle(state.before, 'toggle-before', 'icon-square-split-horizontal',
          'Before and after (\\)')}
        ${toggle(state.zoom, 'toggle-zoom', 'icon-zoom-in',
          'Zoom to 100 % (Z)')}
        ${toggle(state.mode === 'crop', 'crop-tool', 'icon-crop',
          'Crop and straighten (R)')}
        ${historyButtons(state)}
      </span>
    </header>
  `
}

function transport(state: AppState, duration: number) {
  const { playing, time } = state.editor
  const clock = `${formatDuration(time)} / ${formatDuration(duration)}`

  return html`
    <div class="transport">
      <button
        class="icon-button"
        data-action="play"
        title="Play or pause (K)"
      >
        <i class=${playing ? 'icon-pause' : 'icon-play'}></i>
      </button>
      <input
        type="range"
        class="transport-seek"
        min="0"
        max=${duration}
        step="0.01"
        .value=${live(String(time))}
        data-input="seek"
      >
      <span class="toolbar-count">${clock}</span>
    </div>
  `
}

function toggle(on: boolean, action: string, icon: string, title: string) {
  return html`
    <button
      class=${classMap({ 'icon-button': true, on })}
      data-action=${action}
      title=${title}
    >
      <i class=${icon}></i>
    </button>
  `
}

function placeholder(state: AppState, id: string) {
  const url = state.thumbs.get(id)
  if (!url) return html`<span class="stage-spinner icon-loader-circle"></span>`

  return html`<img class="stage-placeholder" src=${url} alt="">`
}

function cropOverlay(state: AppState, layout: StageLayout) {
  const photo = currentPhoto(state)!
  const crop = effectiveCrop(photo.edit, layout.source)
  const box = cropBox(layout, crop)
  const vars = {
    '--x': `${box.x}px`,
    '--y': `${box.y}px`,
    '--w': `${box.w}px`,
    '--h': `${box.h}px`
  }
  const line = state.editor.horizon

  return html`
    <div class="crop" data-crop>
      <div class="crop-box" style=${styleMap(vars)} data-handle="move">
        <span class="crop-thirds"></span>
        ${HANDLES.map(h => html`
          <span class="crop-handle crop-${h}" data-handle=${h}></span>
        `)}
      </div>
      ${line
        ? html`
          <svg class="horizon">
            ${svg`<line
              x1=${line.start.x}
              y1=${line.start.y}
              x2=${line.end.x}
              y2=${line.end.y}
            ></line>`}
          </svg>
        `
        : nothing}
    </div>
  `
}

function filmstrip(state: AppState, lib: Library) {
  const ids = viewIds(state)
  const at = Math.max(0, ids.indexOf(state.current ?? ''))
  const from = Math.max(0, at - FILMSTRIP_REACH)
  const shown = ids.slice(from, at + FILMSTRIP_REACH + 1)

  return html`
    <nav class="filmstrip" data-filmstrip>
      ${repeat(shown, id => id, id => {
        const url = state.thumbs.get(id)
        const classes = { 'film-item': true, current: id === state.current }
        return html`
          <button
            class=${classMap(classes)}
            data-action="open"
            data-id=${id}
            title=${lib.photos[id].name}
          >
            ${url ? html`<img src=${url} alt="">` : nothing}
          </button>
        `
      })}
    </nav>
  `
}
