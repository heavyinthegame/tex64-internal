import { Atom } from '../core/atom-class';
import { Box } from '../core/box';

import type { Context } from '../core/context';
import type { CreateAtomOptions, ToLatexOptions } from '../core/types';
import type { Argument } from './types';
import { argAtoms, defineFunction } from './definitions-utils';

type AuxBodyArg = [Argument | null];
type AuxStringArg = [string | null];

const PREVIEW_LIMIT_BY_COMMAND: Record<string, number> = {
  '\\intertext': 34,
  '\\shortintertext': 28,
};

const PREVIEW_DEFAULT_LIMIT = 24;

const bodyToMathLatex = (
  atom: Atom<(Argument | null)[]>,
  options?: ToLatexOptions
): string =>
  atom.bodyToLatex({
    ...(options ?? {}),
    defaultMode: 'math',
  });

const makeCommandClassSuffix = (command: string): string =>
  command
    .replace(/^\\/, '')
    .replace(/\*/g, 'star')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');

const normalizePreview = (command: string, value: string): string => {
  const compact = value
    .replace(/\\placeholder(?:\{[^{}]*\})?/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!compact) return '...';

  const limit = PREVIEW_LIMIT_BY_COMMAND[command] ?? PREVIEW_DEFAULT_LIMIT;
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(1, limit - 1))}…`;
};

const makeTextBadgePart = (
  context: Context,
  value: string,
  classes: string
): Box =>
  new Box(value, {
    mode: 'text',
    type: 'ord',
    classes,
    maxFontSize: context.scalingFactor,
    style: {
      variant: 'normal',
      variantStyle: 'up',
    },
  });

const renderAuxCommandBadge = (
  atom: Atom<(Argument | null)[]>,
  context: Context,
  options: { preview?: string } = {}
): Box => {
  const commandName = atom.command.replace(/^\\/, '');
  const classSuffix = makeCommandClassSuffix(atom.command);
  const parts: Box[] = [
    makeTextBadgePart(context, commandName, 'ML__tex64-aux-command-name'),
  ];

  if (typeof options.preview === 'string') {
    parts.push(
      makeTextBadgePart(context, options.preview, 'ML__tex64-aux-command-arg')
    );
  }

  const box = new Box(parts, {
    type: 'ord',
    classes: `ML__tex64-aux-command ML__tex64-aux-command--${classSuffix}`,
    isSelected: atom.isSelected,
  });

  atom.bind(context, box);
  if (atom.caret) box.caret = atom.caret;
  return box;
};

const serializeBodyArgCommand = (
  atom: Atom<(Argument | null)[]>,
  options: ToLatexOptions
): string => `${atom.command}{${bodyToMathLatex(atom, options)}}`;

const createBodyArgAtom = (
  options: CreateAtomOptions<AuxBodyArg>
): Atom<AuxBodyArg> =>
  new Atom({
    ...options,
    type: 'mord',
    body: argAtoms(options.args?.[0]),
  });

const createStringArgAtom = (
  options: CreateAtomOptions<AuxStringArg>
): Atom<AuxStringArg> =>
  new Atom({
    ...options,
    type: 'mord',
  });

const readStringArg = (atom: Atom<(Argument | null)[]>): string => {
  const value = atom.args?.[0];
  return typeof value === 'string' ? value : '';
};

const AUX_BODY_COMMANDS = [
  'label',
  'tag',
  'tag*',
  'eqref',
  'ref',
  'pageref',
  'autoref',
] as const;

for (const command of AUX_BODY_COMMANDS) {
  defineFunction(command, '{payload:math}', {
    ifMode: 'math',
    createAtom: createBodyArgAtom,
    serialize: serializeBodyArgCommand,
    render: (atom, context) =>
      renderAuxCommandBadge(atom, context, {
        preview: normalizePreview(atom.command, bodyToMathLatex(atom)),
      }),
  });
}

const AUX_STRING_COMMANDS = [
  'intertext',
  'shortintertext',
] as const;

for (const command of AUX_STRING_COMMANDS) {
  defineFunction(command, '{payload:balanced-string}', {
    ifMode: 'math',
    createAtom: createStringArgAtom,
    serialize: (atom) => `${atom.command}{${readStringArg(atom)}}`,
    render: (atom, context) =>
      renderAuxCommandBadge(atom, context, {
        preview: normalizePreview(atom.command, readStringArg(atom)),
      }),
  });
}

const createBareAuxAtom = (
  options: CreateAtomOptions<[]>
): Atom<[]> =>
  new Atom({
    ...options,
    type: 'mord',
  });

defineFunction(['notag', 'nonumber'], '', {
  ifMode: 'math',
  createAtom: createBareAuxAtom,
  serialize: (atom) => atom.command,
  render: (atom, context) => renderAuxCommandBadge(atom, context),
});
