/** The sections of the Add-ons dialog: the catalog's categories, each with the key of its heading. */
import type { GameAddonCategory } from '../types.ts'
import type { GameAddonsUiKey } from './locales.ts'

/**
 * The heading key of each category. The dialog shows the categories in this order, which is the order of the catalog's
 * index, so a user and an agent find an add-on under the same heading.
 */
export const CATEGORY_HEADINGS = {
  'environment': 'addons.category.environment',
  'rendering': 'addons.category.rendering',
  'characters': 'addons.category.characters',
  'physics': 'addons.category.physics',
  'gameplay': 'addons.category.gameplay',
  'camera': 'addons.category.camera',
  'interface': 'addons.category.interface',
  'two-d': 'addons.category.twoD',
  'kits': 'addons.category.kits',
  'assets': 'addons.category.assets',
  'testing': 'addons.category.testing',
} as const satisfies Record<GameAddonCategory, GameAddonsUiKey>

/** The categories in the order of their sections. */
export const CATEGORY_ORDER = Object.keys(CATEGORY_HEADINGS) as readonly GameAddonCategory[]
