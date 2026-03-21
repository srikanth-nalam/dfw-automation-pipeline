/**
 * @file VcenterApiAdapter.js
 * @description Transforms the pipeline's internal tag model to and from the
 *   vSphere VAPI (vCenter Automation API) format. Handles tag association
 *   payloads, tag list responses, and category specification creation.
 *
 * vCenter VAPI tag association format:
 *   {
 *     object_id: { id: "<vmMoid>", type: "VirtualMachine" },
 *     tag_id: "<tag-id>"
 *   }
 *
 * @module adapters/VcenterApiAdapter
 */

'use strict';

/**
 * Valid tag cardinality values for vCenter category specifications.
 *
 * @constant {Set<string>}
 * @private
 */
const VALID_CARDINALITIES = new Set(['SINGLE', 'MULTIPLE']);

/**
 * Default associable types when creating a category.
 *
 * @constant {string[]}
 * @private
 */
const DEFAULT_ASSOCIABLE_TYPES = ['VirtualMachine'];

/**
 * VcenterApiAdapter converts between the pipeline's internal tag model and
 * the vSphere VAPI tag association format. Also generates category
 * specification payloads for vCenter tag category provisioning.
 *
 * All methods are stateless and can be used statically or on an instance.
 *
 * @class VcenterApiAdapter
 */
class VcenterApiAdapter {
  /**
   * Converts the internal tag model and a VM's Managed Object ID (MOID)
   * into an array of vCenter VAPI tag association payloads.
   *
   * Each tag value produces one association object. Multi-value categories
   * (arrays) produce one association per value.
   *
   * The method expects a `tagIdResolver` mapping that translates
   * `"Category:Value"` pairs into their corresponding vCenter tag IDs.
   * If no resolver is supplied, the tag ID is synthesised as
   * `"urn:vmomi:InventoryServiceTag:<category>-<value>:GLOBAL"` for
   * testing/demonstration purposes.
   *
   * @param {Object} tags - Internal tag map. Keys are category names,
   *   values are strings or arrays of strings.
   * @param {string} vmMoid - The vCenter Managed Object Reference ID of
   *   the target VM (e.g. `'vm-42'`).
   * @param {Object} [tagIdResolver=null] - Optional map of
   *   `"Category:Value"` -> `tagId` strings. When omitted, synthetic IDs
   *   are generated.
   * @returns {Array<{
   *   object_id: { id: string, type: string },
   *   tag_id: string
   * }>} Array of VAPI tag association payloads.
   *
   * @throws {Error} When `tags` is not a valid object or `vmMoid` is empty.
   *
   * @example
   * const adapter = new VcenterApiAdapter();
   * const assignments = adapter.toVapiTagAssignment(
   *   { Application: 'APP001', Compliance: ['PCI', 'HIPAA'] },
   *   'vm-42'
   * );
   * // [
   * //   { object_id: { id: 'vm-42', type: 'VirtualMachine' }, tag_id: '...' },
   * //   { object_id: { id: 'vm-42', type: 'VirtualMachine' }, tag_id: '...' },
   * //   { object_id: { id: 'vm-42', type: 'VirtualMachine' }, tag_id: '...' }
   * // ]
   */
  toVapiTagAssignment(tags, vmMoid, tagIdResolver = null) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
      throw new Error(
        '[DFW-2010] tags must be a non-null object mapping category names to values.'
      );
    }
    if (!vmMoid || typeof vmMoid !== 'string' || vmMoid.trim() === '') {
      throw new Error(
        '[DFW-2010] vmMoid is required and must be a non-empty string.'
      );
    }

    const assignments = [];
    const objectId = {
      id: vmMoid.trim(),
      type: 'VirtualMachine'
    };

    for (const [category, value] of Object.entries(tags)) {
      if (!category || value === null || value === undefined) {
        continue;
      }

      const values = Array.isArray(value) ? value : [value];

      for (const v of values) {
        const strVal = String(v).trim();
        if (strVal === '') {
          continue;
        }

        const tagId = VcenterApiAdapter._resolveTagId(
          category,
          strVal,
          tagIdResolver
        );

        assignments.push({
          object_id: { ...objectId },
          tag_id: tagId
        });
      }
    }

    return assignments;
  }

  /**
   * Converts a vCenter VAPI tag list response back to the internal tag
   * model. The input is an array of tag descriptor objects as returned by
   * the VAPI `/tagging/tag-association?~action=list-attached-tags-on-objects`
   * endpoint (or similar).
   *
   * Each descriptor must include either:
   *   - `category_name` and `tag_name`, OR
   *   - `category_id`, `tag_id`, and a resolver.
   *
   * When multiple tags share the same category, they are collected into
   * an array.
   *
   * @param {Array<{
   *   category_name?: string,
   *   tag_name?: string,
   *   category_id?: string,
   *   tag_id?: string,
   *   name?: string,
   *   description?: string
   * }>} vapiTags - Tag descriptors from VAPI.
   * @returns {Object} Internal tag map with category names as keys.
   *
   * @example
   * const internal = adapter.fromVapiTagList([
   *   { category_name: 'Application', tag_name: 'APP001' },
   *   { category_name: 'Compliance', tag_name: 'PCI' },
   *   { category_name: 'Compliance', tag_name: 'HIPAA' }
   * ]);
   * // { Application: 'APP001', Compliance: ['PCI', 'HIPAA'] }
   */
  fromVapiTagList(vapiTags) {
    if (!Array.isArray(vapiTags)) {
      return {};
    }

    const result = {};

    for (const entry of vapiTags) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      // Resolve category and tag names (prefer explicit names, fall back to IDs)
      const category = VcenterApiAdapter._trimOrEmpty(
        entry.category_name || entry.category_id || ''
      );
      const tagValue = VcenterApiAdapter._trimOrEmpty(
        entry.tag_name || entry.name || entry.tag_id || ''
      );

      if (!category || !tagValue) {
        continue;
      }

      if (result[category] === undefined) {
        // First value — store as string
        result[category] = tagValue;
      } else if (Array.isArray(result[category])) {
        // Already an array — append if not duplicate
        if (!result[category].includes(tagValue)) {
          result[category].push(tagValue);
        }
      } else {
        // Second distinct value — promote to array
        if (result[category] !== tagValue) {
          result[category] = [result[category], tagValue];
        }
      }
    }

    return result;
  }

  /**
   * Creates a vCenter VAPI category specification payload suitable for
   * creating a new tag category via
   * `POST /rest/com/vmware/cis/tagging/category`.
   *
   * @param {string} categoryName - The display name of the category.
   * @param {string} [cardinality='SINGLE'] - Tag cardinality:
   *   `'SINGLE'` (one tag per object) or `'MULTIPLE'` (many tags per object).
   * @param {Object} [options={}] - Additional options.
   * @param {string} [options.description] - Human-readable description.
   * @param {string[]} [options.associableTypes] - Object types this category
   *   can be attached to. Defaults to `['VirtualMachine']`.
   * @returns {{
   *   create_spec: {
   *     name: string,
   *     description: string,
   *     cardinality: string,
   *     associable_types: string[]
   *   }
   * }}
   *
   * @throws {Error} When `categoryName` is empty or `cardinality` is invalid.
   *
   * @example
   * const spec = adapter.toCategorySpec('Compliance', 'MULTIPLE', {
   *   description: 'Compliance frameworks for the VM'
   * });
   * // {
   * //   create_spec: {
   * //     name: 'Compliance',
   * //     description: 'Compliance frameworks for the VM',
   * //     cardinality: 'MULTIPLE',
   * //     associable_types: ['VirtualMachine']
   * //   }
   * // }
   */
  toCategorySpec(categoryName, cardinality = 'SINGLE', options = {}) {
    if (!categoryName || typeof categoryName !== 'string' || categoryName.trim() === '') {
      throw new Error(
        '[DFW-2011] categoryName is required and must be a non-empty string.'
      );
    }

    const normalizedCardinality = typeof cardinality === 'string'
      ? cardinality.trim().toUpperCase()
      : 'SINGLE';

    if (!VALID_CARDINALITIES.has(normalizedCardinality)) {
      throw new Error(
        `[DFW-2011] Invalid cardinality "${cardinality}". Must be "SINGLE" or "MULTIPLE".`
      );
    }

    const description = typeof options.description === 'string'
      ? options.description
      : `Tag category: ${categoryName.trim()}`;

    const associableTypes = Array.isArray(options.associableTypes)
      ? options.associableTypes.filter(t => typeof t === 'string' && t.trim() !== '')
      : [...DEFAULT_ASSOCIABLE_TYPES];

    return {
      create_spec: {
        name: categoryName.trim(),
        description,
        cardinality: normalizedCardinality,
        associable_types: associableTypes
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves a tag ID using the provided resolver map, or generates a
   * synthetic ID for testing purposes.
   *
   * @private
   * @param {string} category - Tag category name.
   * @param {string} value - Tag value.
   * @param {Object|null} resolver - Optional `{ "Category:Value": "tagId" }` map.
   * @returns {string} The resolved or synthetic tag ID.
   */
  static _resolveTagId(category, value, resolver) {
    const key = `${category}:${value}`;

    if (resolver && typeof resolver === 'object' && resolver[key]) {
      return String(resolver[key]);
    }

    // Synthetic ID for testing — mirrors vCenter URN format
    const sanitized = `${category}-${value}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');

    return `urn:vmomi:InventoryServiceTag:${sanitized}:GLOBAL`;
  }

  /**
   * Trims a value to a string, returning empty string for non-strings.
   *
   * @private
   * @param {*} value
   * @returns {string}
   */
  static _trimOrEmpty(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
}

module.exports = VcenterApiAdapter;
