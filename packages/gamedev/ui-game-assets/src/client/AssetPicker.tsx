/**
 * The asset picker at the top of the Assets tab: a trigger naming the selected asset, and a dropdown with a search
 * field, an All / 2D / 3D filter, and the project's assets sorted into its folders. Typing replaces the folder tree
 * with the assets whose name or path matches, best match first. Keyboard focus stays in the search field while the
 * arrow keys move through the rows and Enter opens a folder or picks an asset.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseFillRegular, IconSearchOutlineRegular,
  Input, MenuSurface, SegmentedControl, StateDot, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelFileIcon } from './icon.tsx'
import type { NS } from './locales.ts'
import type { AssetEntry } from './scan.ts'
import type { ScanState, ViewState } from './source.ts'
import { buildTree, initialOpen, rowsAbove, searchAssets, treeRows, type KindFilter, type TreeRow } from './tree.ts'
import css from './AssetPicker.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the picker draws and reports. */
export interface AssetPickerProps {
  /** The project scan. */
  readonly scanState: ScanState
  /** The reader's choices. */
  readonly view: ViewState
  /** The selected asset, if any. */
  readonly selected: AssetEntry | undefined
  /** Whether the dropdown is open. */
  readonly open: boolean
  /** @param open - whether the dropdown should be open. */
  readonly onOpenChange: (open: boolean) => void
  /** @param path - workspace path of the picked asset. */
  readonly onSelect: (path: string) => void
  /** @param keys - row keys of the folders to show open. */
  readonly onOpenFolders: (keys: readonly string[]) => void
  /** @param filter - the kinds to show. */
  readonly onFilter: (filter: KindFilter) => void
  /** Scan the project again after a failed scan. */
  readonly onRetry: () => void
  readonly t: Translate
}

/** One drawn row: a tree row, or a search result. */
type PickerRow = TreeRow | { readonly kind: 'result'; readonly asset: AssetEntry }

function rowKey(row: PickerRow): string {
  return row.kind === 'folder' ? `folder:${row.node.path}` : `asset:${row.asset.path}`
}

/**
 * The glyph of an asset row.
 * @param props - the asset.
 * @returns the image or model file glyph at 16px.
 */
export function AssetIcon({ asset }: { readonly asset: AssetEntry }): ReactNode {
  return asset.format.kind === 'image'
    ? <FileTypeIcon kind="image" size={16} className={css.icon} />
    : <ModelFileIcon size={16} className={css.icon} />
}

/**
 * Draw the picker.
 * @param props - scan, choices, and callbacks.
 * @returns the trigger and, while open, the dropdown in a portal.
 */
export function AssetPicker({
  scanState, view, selected, open, onOpenChange, onSelect, onOpenFolders, onFilter, onRetry, t,
}: AssetPickerProps): ReactNode {
  const id = useId().replaceAll(':', '')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string>()
  const scan = scanState.scan
  const filter = view.filter
  const tree = useMemo(() => scan === undefined ? undefined : buildTree(scan.assets, filter), [scan, filter])
  const openKeys = useMemo(
    () => new Set(view.open ?? (tree === undefined ? [] : initialOpen(tree, selected?.path))),
    [view.open, tree, selected?.path],
  )
  const searching = query.trim() !== ''
  const rows = useMemo<readonly PickerRow[]>(() => {
    if (scan === undefined || tree === undefined) return []
    if (searching) return searchAssets(scan.assets, query, filter).map(asset => ({ kind: 'result', asset }) as const)
    return treeRows(tree, openKeys)
  }, [scan, tree, searching, query, filter, openKeys])
  const activeRow = rows.find(row => rowKey(row) === active)
  const rowId = useCallback((key: string): string => `${id}-row-${encodeURIComponent(key)}`, [id])

  useDismissOnOutsidePointer(rootRef, open, onOpenChange, menuRef)

  // Opening shows the selected asset: its folders open, its row active and scrolled to, and the search field focused.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setQuery('')
    if (tree !== undefined) {
      const keys = new Set(view.open ?? initialOpen(tree, selected?.path))
      if (selected !== undefined) for (const key of rowsAbove(tree, selected.path)) keys.add(key)
      onOpenFolders([...keys])
    }
    setActive(selected === undefined ? undefined : `asset:${selected.path}`)
    searchRef.current?.focus()
  }, [open, tree, view.open, selected, onOpenFolders])

  // The active row stays in view as the keyboard moves it.
  useEffect(() => {
    if (!open || active === undefined) return
    listRef.current?.ownerDocument.getElementById(rowId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active, rows, rowId])

  const toggle = (key: string): void => {
    const next = new Set(openKeys)
    if (!next.delete(key)) next.add(key)
    onOpenFolders([...next])
  }
  const close = (focusTrigger: boolean): void => {
    onOpenChange(false)
    if (focusTrigger) triggerRef.current?.focus()
  }
  const activate = (row: PickerRow): void => {
    if (row.kind === 'folder') {
      toggle(row.node.path)
      setActive(rowKey(row))
      return
    }
    onSelect(row.asset.path)
    close(true)
  }
  const move = (step: 1 | -1): void => {
    if (rows.length === 0) return
    const index = activeRow === undefined ? -1 : rows.indexOf(activeRow)
    const next = index === -1 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step))
    setActive(rowKey(rows[next] as PickerRow))
  }
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        move(event.key === 'ArrowDown' ? 1 : -1)
        return
      case 'Enter':
        if (activeRow === undefined) return
        event.preventDefault()
        activate(activeRow)
        return
      case 'ArrowRight':
        if (activeRow?.kind !== 'folder' || activeRow.open || query !== '') return
        event.preventDefault()
        toggle(activeRow.node.path)
        return
      case 'ArrowLeft': {
        if (query !== '' || activeRow === undefined || activeRow.kind === 'result') return
        event.preventDefault()
        if (activeRow.kind === 'folder' && activeRow.open) {
          toggle(activeRow.node.path)
          return
        }
        // Otherwise the row's folder becomes active: the nearest folder row above it one level up.
        const index = rows.indexOf(activeRow)
        const parent = rows.slice(0, index).reverse().find(row => row.kind === 'folder' && row.depth === activeRow.depth - 1)
        if (parent !== undefined) setActive(rowKey(parent))
        return
      }
      default:
    }
  }

  const triggerLabel = selected === undefined ? t('picker.choose') : selected.name
  const anchorStyle = { '--dsh-asset-picker-anchor': `--dsh-asset-picker-${id}` } as CSSProperties
  const panelId = `${id}-filter-${filter}-panel`
  const listRole = searching ? 'listbox' : 'tree'
  const empty = scan === undefined
    ? undefined
    : searching ? t('picker.noMatch')
      : filter === 'image' ? t('picker.noImages')
        : filter === 'model' ? t('picker.noModels')
          : t('state.empty.description')

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!open || !(next instanceof Node)) return
        if (rootRef.current?.contains(next) !== true && menuRef.current?.contains(next) !== true) onOpenChange(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        style={anchorStyle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-dialog` : undefined}
        title={selected?.path}
        onClick={() => { onOpenChange(!open) }}
      >
        {selected !== undefined && <AssetIcon asset={selected} />}
        <span className={clsx(css.triggerName, selected === undefined && css.placeholder)}>{triggerLabel}</span>
        {selected !== undefined && selected.folder !== '' && <span className={css.triggerFolder}>{selected.folder}</span>}
        <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-dialog`}
          role="dialog"
          aria-label={t('picker.dialog')}
          className={css.menu}
          style={anchorStyle}
          onMouseDown={(event) => {
            // Rows and tabs keep the keyboard in the search field; the field itself takes the caret.
            if (event.target instanceof HTMLElement && event.target.closest('input') === null) event.preventDefault()
          }}
        >
          <div className={css.searchRow}>
            <Input
              ref={searchRef}
              className={clsx(css.search, query !== '' && css.searchWithQuery)}
              icon={<IconSearchOutlineRegular size={14} />}
              type="text"
              role="combobox"
              aria-label={t('picker.search')}
              aria-expanded={rows.length > 0}
              aria-controls={`${id}-rows`}
              aria-autocomplete="list"
              aria-activedescendant={activeRow === undefined ? undefined : rowId(rowKey(activeRow))}
              placeholder={t('picker.search')}
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(undefined)
              }}
              onKeyDown={onSearchKeyDown}
            />
            {query !== '' && (
              <button type="button" className={css.searchClear} aria-label={t('picker.clear')}
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}>
                <IconCloseFillRegular size={14} />
              </button>
            )}
          </div>
          <SegmentedControl<KindFilter>
            id={`${id}-filter`}
            className={css.filter}
            label={t('picker.kinds')}
            value={filter}
            options={[
              { value: 'all', label: t('filter.all') },
              { value: 'image', label: t('filter.image') },
              { value: 'model', label: t('filter.model') },
            ]}
            onChange={(next) => {
              onFilter(next)
              setActive(undefined)
            }}
          />
          <div id={panelId} role="tabpanel" aria-labelledby={`${id}-filter-${filter}`} className={css.panel}>
            {scan === undefined && scanState.status !== 'failed' && (
              <div className={css.status} role="status"><StateDot state="ongoing" />{t('picker.scanning')}</div>
            )}
            {scan === undefined && scanState.status === 'failed' && (
              <div className={css.failure} role="alert">
                <span>{t('picker.failed')}</span>
                <button type="button" className={css.retry} onClick={onRetry}>{t('action.retry')}</button>
              </div>
            )}
            <div
              ref={listRef}
              id={`${id}-rows`}
              role={listRole}
              aria-label={t('picker.dialog')}
              className={clsx(css.rows, 'scrollable')}
              hidden={rows.length === 0}
            >
              {rows.map((row) => {
                const key = rowKey(row)
                const isActive = key === active
                if (row.kind === 'folder') {
                  return (
                    <button
                      key={key}
                      id={rowId(key)}
                      data-row-key={key}
                      type="button"
                      tabIndex={-1}
                      role="treeitem"
                      aria-level={row.depth + 1}
                      aria-expanded={row.open}
                      className={clsx(css.row, isActive && css.rowActive)}
                      style={{ '--dsh-asset-depth': String(row.depth) } as CSSProperties}
                      title={row.node.path}
                      onMouseMove={isActive ? undefined : () => { setActive(key) }}
                      onClick={() => { activate(row) }}
                    >
                      <IconChevronRightOutlineRegular size={12} className={clsx(css.disclosure, row.open && css.disclosureOpen)} />
                      <FileTypeIcon kind="folder" size={16} className={css.icon} />
                      <span className={css.name}>{row.label}</span>
                      <span className={css.count} aria-hidden="true">{row.node.count}</span>
                    </button>
                  )
                }
                const current = row.asset.path === selected?.path
                return (
                  <button
                    key={key}
                    id={rowId(key)}
                    data-row-key={key}
                    type="button"
                    tabIndex={-1}
                    role={row.kind === 'result' ? 'option' : 'treeitem'}
                    aria-level={row.kind === 'asset' ? row.depth + 1 : undefined}
                    aria-selected={current}
                    className={clsx(css.row, row.kind === 'asset' && css.assetRow, isActive && css.rowActive, current && css.rowCurrent)}
                    style={row.kind === 'asset' ? { '--dsh-asset-depth': String(row.depth) } as CSSProperties : undefined}
                    title={row.asset.path}
                    onMouseMove={isActive ? undefined : () => { setActive(key) }}
                    onClick={() => { activate(row) }}
                  >
                    <AssetIcon asset={row.asset} />
                    <span className={css.name}>{row.asset.name}</span>
                    {row.kind === 'result' && row.asset.folder !== '' && <span className={css.folder}>{row.asset.folder}</span>}
                  </button>
                )
              })}
            </div>
            {scan !== undefined && rows.length === 0 && <div className={css.status} role="status">{empty}</div>}
            {scan?.truncated === true && <div className={css.note}>{t('picker.truncated')}</div>}
            {scan !== undefined && scan.unreadable > 0 && <div className={css.note}>{t('picker.unreadable')}</div>}
            {scan !== undefined && scanState.status === 'failed' && (
              <div className={css.failure} role="alert">
                <span>{t('picker.failed')}</span>
                <button type="button" className={css.retry} onClick={onRetry}>{t('action.retry')}</button>
              </div>
            )}
          </div>
        </MenuSurface>,
        document.body,
      )}
    </div>
  )
}
