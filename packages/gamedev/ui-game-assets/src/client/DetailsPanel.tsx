/**
 * The details of the shown asset, under the view: for a model its size, geometry, materials and their textures, its
 * bones as a tree (choosing one marks it on the model), its clips (choosing one plays it), its morph targets with a
 * slider each, and the files it names that are missing; for an image its size, transparency, colors, and the 2D
 * animations it plays or takes part in (choosing one plays it). The same details are what the agent's `asset_view`
 * reports.
 */
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { fileSizeText, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssetDetails, ImageAssetDetails, ModelAssetDetails } from '@deepseek-ai/dsh-game-assets/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './DetailsPanel.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** The morph targets of one mesh with their current influences. */
export interface MorphControl {
  /** The stage's key for the mesh. */
  readonly key: string
  readonly mesh: string
  readonly targets: readonly string[]
  readonly values: readonly number[]
}

/** What the panel shows and what choosing in it does. */
export interface DetailsPanelProps {
  readonly details: AssetDetails
  readonly t: Translate
  /** The playing clip's or 2D animation's name. */
  readonly playing?: string | undefined
  /** @param name - the clip or 2D animation to play. */
  readonly onPlay?: (name: string) => void
  /** Index of the marked bone. */
  readonly selectedBone?: number | undefined
  /** @param index - the bone to mark, or undefined for none. */
  readonly onSelectBone?: (index: number | undefined) => void
  /** Each mesh's morph targets and influences. */
  readonly morphs?: readonly MorphControl[]
  /** Set one morph target's influence from 0 to 1. */
  readonly onMorph?: (key: string, index: number, value: number) => void
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 })

/** A collapsible group of details. */
interface SectionProps {
  readonly title: string
  readonly children: ReactNode
  readonly open?: boolean
}

function Section({ title, children, open = true }: SectionProps): ReactNode {
  const [expanded, setExpanded] = useState(open)
  return (
    <section className={css.section}>
      <button type="button" className={css.heading} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
        <IconChevronRightOutlineRegular size={12} className={clsx(css.chevron, expanded && css.open)} />
        <span>{title}</span>
      </button>
      {expanded && <div className={css.body}>{children}</div>}
    </section>
  )
}

function Facts({ rows }: { readonly rows: readonly (readonly [label: string, value: ReactNode])[] }): ReactNode {
  return (
    <dl className={css.facts}>
      {rows.map(([label, value]) => (
        <div key={label} className={css.fact}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ModelDetails(props: DetailsPanelProps & { readonly details: ModelAssetDetails }): ReactNode {
  const { details, t, playing, onPlay, selectedBone, onSelectBone, morphs, onMorph } = props
  const size = details.max.map((value, axis) => NUMBER.format(value - (details.min[axis] ?? 0))).join(' × ')
  const depths: number[] = []
  for (const [index, bone] of details.bones.entries()) depths[index] = bone.parent === undefined ? 0 : (depths[bone.parent] ?? 0) + 1
  const unnamed = t('details.unnamed')
  return (
    <>
      <Section title={t('details.model')}>
        <Facts rows={[
          [t('details.size'), size],
          [t('details.triangles'), NUMBER.format(details.triangles)],
          [t('details.vertices'), NUMBER.format(details.vertices)],
          [t('details.meshes'), NUMBER.format(details.meshes)],
          [t('details.nodes'), NUMBER.format(details.nodes)],
          [t('details.format'), details.format],
          [t('details.fileSize'), fileSizeText(details.bytes)],
        ]} />
      </Section>
      {details.animations.length > 0 && (
        <Section title={t('details.animations', { count: details.animations.length })}>
          <ul className={css.list}>
            {details.animations.map((clip, index) => (
              <li key={`${clip.name}#${String(index)}`}>
                <button type="button" className={css.row} aria-pressed={playing === clip.name} title={t('details.play', { name: clip.name || unnamed })}
                  onClick={() => { onPlay?.(clip.name) }}>
                  <span className={css.name}>{clip.name === '' ? unnamed : clip.name}</span>
                  <span className={css.meta}>{t('details.seconds', { seconds: clip.seconds.toFixed(2) })}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {details.boneCount > 0 && (
        <Section title={t('details.skeleton', { count: details.boneCount })} open={false}>
          <ul className={css.list}>
            {details.bones.map((bone, index) => (
              <li key={`${bone.name}#${String(index)}`}>
                <button type="button" className={css.row} aria-pressed={selectedBone === index}
                  style={{ paddingInlineStart: `${String(6 + Math.min(depths[index] ?? 0, 16) * 10)}px` }}
                  title={t('details.selectBone', { name: bone.name || unnamed })}
                  onClick={() => { onSelectBone?.(selectedBone === index ? undefined : index) }}>
                  <span className={css.name}>{bone.name === '' ? unnamed : bone.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {details.bones.length < details.boneCount && <p className={css.note}>{t('details.more', { count: details.boneCount - details.bones.length })}</p>}
        </Section>
      )}
      {morphs !== undefined && morphs.length > 0 && (
        <Section title={t('details.morphs')}>
          {morphs.map(morph => (
            <div key={morph.key} className={css.morph}>
              <p className={css.subheading}>{morph.mesh === '' ? unnamed : morph.mesh}</p>
              {morph.targets.map((target, index) => (
                <label key={`${target}#${String(index)}`} className={css.slider}>
                  <span className={css.name}>{target}</span>
                  <input type="range" min={0} max={1} step={0.01} value={morph.values[index] ?? 0}
                    onChange={(event) => { onMorph?.(morph.key, index, Number(event.currentTarget.value)) }} />
                </label>
              ))}
            </div>
          ))}
        </Section>
      )}
      {details.materialCount > 0 && (
        <Section title={t('details.materials', { count: details.materialCount })} open={false}>
          <ul className={css.list}>
            {details.materials.map((material, index) => (
              <li key={`${material.name}#${String(index)}`} className={css.item}>
                <span className={css.itemTitle}>
                  {material.color !== undefined && <span className={css.swatch} style={{ background: material.color }} aria-hidden="true" />}
                  <span className={css.name}>{material.name === '' ? unnamed : material.name}</span>
                </span>
                <span className={css.meta}>
                  {[
                    material.type.replace(/^Mesh/u, '').replace(/Material$/u, ''),
                    material.metalness === undefined ? undefined : `${t('details.metalness')} ${NUMBER.format(material.metalness)}`,
                    material.roughness === undefined ? undefined : `${t('details.roughness')} ${NUMBER.format(material.roughness)}`,
                    material.transparent ? t('details.transparent') : undefined,
                    material.doubleSided ? t('details.doubleSided') : undefined,
                  ].filter(part => part !== undefined).join(' · ')}
                </span>
                {material.maps.map(map => (
                  <span key={map.slot} className={css.map}>{map.slot}: {map.texture}</span>
                ))}
              </li>
            ))}
          </ul>
          {details.materials.length < details.materialCount && <p className={css.note}>{t('details.more', { count: details.materialCount - details.materials.length })}</p>}
        </Section>
      )}
      {details.textureCount > 0 && (
        <Section title={t('details.textures', { count: details.textureCount })} open={false}>
          <ul className={css.list}>
            {details.textures.map((texture, index) => (
              <li key={`${texture.name}#${String(index)}`} className={css.pair}>
                <span className={css.name}>{texture.name}</span>
                <span className={css.meta}>{texture.width > 0 ? `${texture.width} × ${texture.height}` : '—'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {details.missing.length > 0 && (
        <Section title={t('details.missing')}>
          <ul className={css.list}>
            {details.missing.map(name => <li key={name} className={css.pair}><span className={css.name}>{name}</span></li>)}
          </ul>
        </Section>
      )}
    </>
  )
}

function ImageDetails({ details, t, playing, onPlay }: DetailsPanelProps & { readonly details: ImageAssetDetails }): ReactNode {
  return (
    <>
      <Section title={t('details.image')}>
        <Facts rows={[
          [t('details.dimensions'), `${details.width} × ${details.height}`],
          [t('details.transparency'), t(`details.transparency.${details.transparency}`)],
          [t('details.colors'), details.colors > 256 ? t('details.colors.many') : NUMBER.format(details.colors)],
          [t('details.format'), details.format],
          [t('details.fileSize'), fileSizeText(details.bytes)],
        ]} />
      </Section>
      <Section title={t('details.animations', { count: details.animations.length })}>
        {details.animations.length === 0
          ? <p className={css.note}>{t('details.noAnimations')}</p>
          : (
            <ul className={css.list}>
              {details.animations.map(animation => (
                <li key={animation.name}>
                  <button type="button" className={css.row} aria-pressed={playing === animation.name} title={t('details.play', { name: animation.name })}
                    onClick={() => { onPlay?.(animation.name) }}>
                    <span className={css.name}>{animation.name}</span>
                    <span className={css.meta}>
                      {t(`details.source.${animation.source}`)} · {t(animation.frames === 1 ? 'details.frames.one' : 'details.frames.other', { count: animation.frames })} · {t('details.fps', { fps: NUMBER.format(animation.fps) })}
                    </span>
                  </button>
                  {animation.definedIn !== undefined && (
                    <span className={css.where} title={animation.definedIn}>{animation.definedIn}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Section>
    </>
  )
}

/**
 * Show an asset's details.
 * @param props - the details, copy, and what choosing a clip, animation, bone, or morph target does.
 * @returns the panel.
 */
export function DetailsPanel(props: DetailsPanelProps): ReactNode {
  return (
    <div className={css.panel} role="region" aria-label={props.t('details.title')}>
      {props.details.kind === 'model'
        ? <ModelDetails {...props} details={props.details} />
        : <ImageDetails {...props} details={props.details} />}
    </div>
  )
}
