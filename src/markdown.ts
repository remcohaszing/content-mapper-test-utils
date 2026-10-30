import type {
  AlignType,
  Heading,
  ListItem,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow
} from 'mdast'

import type { MappedOutput, SpanMapFeature, SpanMapping, TransformResult } from './protocol.js'

import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import { assertEqual } from 'snapshot-fixtures'

const allFeatures = [
  'Hover',
  'SignatureHelp',
  'Completion',
  'Definition',
  'TypeDefinition',
  'Implementation',
  'References',
  'DocumentHighlights',
  'Rename',
  'CallHierarchy',
  'CodeActions',
  'Formatting',
  'InlayHints',
  'SemanticTokens',
  'FoldingRanges',
  'SelectionRanges',
  'LinkedEditing',
  'AutoInsert',
  'DocumentSymbols',
  'CodeLens'
]

/**
 * Create an mdast heading.
 *
 * @param text
 *   The text content.
 * @param depth
 *   The depth of the heading.
 * @returns
 *   The mdast heading.
 */
function heading(text: string, depth: Heading['depth']): Heading {
  return {
    type: 'heading',
    depth,
    children: [{ type: 'text', value: text }]
  }
}

/**
 * Represent mappings as a markdown table.
 *
 * @param original
 *   The original content.
 * @param text
 *   The transformed text output.
 * @param mappings
 *   The span mappings to represent.
 * @returns
 *   The markdown table.
 */
function toFeatureTable(original: string, text: string, mappings: SpanMapping[]): Table {
  const align: AlignType[] = [null, 'right', null, 'right']
  const header: TableRow = {
    type: 'tableRow',
    children: [
      { type: 'tableCell', children: [{ type: 'text', value: 'Original' }] },
      { type: 'tableCell', children: [] },
      { type: 'tableCell', children: [{ type: 'text', value: 'Virtual' }] },
      { type: 'tableCell', children: [] }
    ]
  }
  const rows: TableRow[] = [header]
  let features: SpanMapFeature = 0
  const knownFeatures = new Set<SpanMapFeature>()

  for (const [, , , , , feature = 1_048_575] of mappings) {
    features |= feature
  }

  for (const [index, value] of allFeatures.entries()) {
    if (features & (1 << index)) {
      align.push('center')
      header.children.push({ type: 'tableCell', children: [{ type: 'text', value }] })
      knownFeatures.add(1 << index)
    }
  }

  const knownFeaturesSorted = [...knownFeatures].sort((a, b) => a - b)

  for (const [
    generatedStart,
    generatedLength,
    originalStart,
    originalLength,
    ,
    feature = 1_048_575
  ] of mappings) {
    const generatedSlice = text.slice(generatedStart, generatedStart + generatedLength)
    const originalSlice = original.slice(originalStart, originalStart + originalLength)

    rows.push({
      type: 'tableRow',
      children: [
        {
          type: 'tableCell',
          children: [{ type: 'inlineCode', value: originalSlice.replaceAll('\n', '⏎') }]
        },
        {
          type: 'tableCell',
          children: [{ type: 'text', value: String(originalStart) }]
        },
        {
          type: 'tableCell',
          children: [{ type: 'inlineCode', value: generatedSlice.replaceAll('\n', '⏎') }]
        },
        {
          type: 'tableCell',
          children: [{ type: 'text', value: String(generatedStart) }]
        },
        ...knownFeaturesSorted.map<TableCell>((knownFeature) => ({
          type: 'tableCell',
          children: [{ type: 'text', value: knownFeature & feature ? '✓' : '' }]
        }))
      ]
    })
  }

  return {
    type: 'table',
    align,
    children: rows
  }
}

/**
 * Render mapped output to markdown.
 *
 * @param original
 *   The original content.
 * @param mappedOutput
 *   The mapped output provided by the content mapper.
 * @param headingDepth
 *   The heading depth to use in the markdown.
 * @returns
 *   A markdown representation of the mapped output.
 */
function mappedOutputToMdast(
  original: string,
  mappedOutput: MappedOutput,
  headingDepth: Heading['depth']
): RootContent[] {
  const { extension, mappings = [], text } = mappedOutput

  const grouped = Object.groupBy(mappings, (item) => item[4])

  const content: RootContent[] = [
    heading('Text', headingDepth),
    { type: 'code', lang: extension.slice(1), value: text }
  ]

  if (grouped[0]) {
    content.push(heading('Verbatim mappings', headingDepth))

    for (const mapping of grouped[0]) {
      const [generatedStart, generatedLength, originalStart, originalLength] = mapping
      const generatedSlice = text.slice(generatedStart, generatedStart + generatedLength)
      const originalSlice = original.slice(originalStart, originalStart + originalLength)
      assertEqual(generatedSlice, originalSlice)
      content.push({
        type: 'code',
        lang: 'jsx',
        meta: mapping.join(' '),
        value: generatedSlice
      })
    }
  }

  if (grouped[1]) {
    content.push(heading('Atom mappings', headingDepth), toFeatureTable(original, text, grouped[1]))
  }

  if (grouped[2]) {
    content.push(
      heading('Alias mappings', headingDepth),
      toFeatureTable(original, text, grouped[2])
    )
  }

  return content
}

/**
 * Render content mapper transform result to markdown.
 *
 * @param original
 *   The original content.
 * @param transformResult
 *   The transform result provided by the content mapper.
 * @returns
 *   A markdown representation of the transform result.
 */
function transformResultToMdast(original: string, transformResult: TransformResult): Root {
  const content = mappedOutputToMdast(original, transformResult, 2)

  if (transformResult.diagnostics?.length) {
    content.push(heading('Diagnostics', 2), {
      type: 'list',
      children: transformResult.diagnostics.map<ListItem>((diagnostic) => ({
        type: 'listItem',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'inlineCode', value: `${diagnostic.start}:${diagnostic.length}` },
              { type: 'text', value: ': ' },
              { type: 'inlineCode', value: diagnostic.messageText }
            ]
          }
        ]
      }))
    })
  }

  if (transformResult.supplemental?.length) {
    content.push(heading('Supplemental', 2))

    for (const supplemental of transformResult.supplemental) {
      content.push(...mappedOutputToMdast(original, supplemental, 3))
    }
  }

  return {
    type: 'root',
    children: content
  }
}

/**
 * Represent TypeScript content mapper mapped output as markdown.
 *
 * @param original
 *   The text content of the original file.
 * @param transformResult
 *   The transform result from the content mapper.
 * @returns
 *   A markdown representation of the transform result.
 */
export function transformResultToMarkdown(
  original: string,
  transformResult: TransformResult
): string {
  const root = transformResultToMdast(original, transformResult)
  return toMarkdown(root, { bullet: '-', emphasis: '_', extensions: [gfmToMarkdown()] })
}
