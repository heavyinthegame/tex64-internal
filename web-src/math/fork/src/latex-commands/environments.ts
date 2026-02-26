import type { Dimension, Environment } from '../public/core-types';

import { Atom } from '../core/atom-class';
import { ArrayAtom, ColumnFormat } from '../atoms/array';

import {
  defineFunction,
  defineRootEnvironment,
  defineTabularEnvironment,
} from './definitions-utils';
import type { Argument, ColspecArgument } from './types';
import { Parser } from 'core/parser';

/*
 The star at the end of the name of an environment indicates that the
 equations will not be numbered and the counter for the equations
 will not be incremented.

\notag will also turn off the numbering (but the counter will still be incremented).
\shoveright and \shoveleft will force alignment of a line

The only difference between `align` and `equation` is the spacing of the formulas.
You should attempt to use `equation` when possible, and `align` when you have multi-line formulas.
`equation` will have space before/after < 1em if line before/after is short enough.

Also: `equation` throws an error when you have an & inside the environment,
so look out for that when converting between the two.

Whereas `align` produces a structure whose width is the full line width
(it's a root environment), `aligned` gives a width that is the actual width
of the contents, thus it can be used as a component in a containing
expression, e.g. for putting the entire alignment in a parenthesis
*/

/** `math` and `displaymath` are older environments, they
 * are equivalent to `\(...\)` and `\[...\]`
 */
defineRootEnvironment(['math', 'displaymath'], makeEnvironment);

/** The `center` environment is a text environment, but
 * we extend it to support math content as well.
 */
defineRootEnvironment('center', makeEnvironment);

/** Note spelling: MULTLINE, not multiline.
 * The `multline` environment is used for long formulas that don't fit on a single line.
 * The first line is left-aligned, the last line is right-aligned, and all lines in between
 * are centered. The `multline*` variant does not number the equation.
 */
defineTabularEnvironment(['multline', 'multline*'], '', makeEnvironment);

/** This is not exactly an environment, but a function that behaves like one: its content is interpreted as multiple rows/lines.
 * The environment `lines` is identical using `\displaylines`.
 */
defineFunction('displaylines', '', {
  parse: (parser: Parser) => {
    parser.skipWhitespace();
    if (!parser.match('<{>')) return [];

    const lines: Atom[][][] = [];
    let line: Atom[] = [];

    // Collect any elements left of the command
    if (parser.mathlist.length > 0) lines.push([parser.mathlist]);

    parser.beginContext({ tabular: true, root: true });
    do {
      if (parser.end() || parser.match('<}>')) break;
      if (parser.matchColumnSeparator() || parser.matchRowSeparator()) {
        lines.push([line]);
        line = [];
      } else {
        line.push(
          ...parser.scan((token) =>
            ['<}>', '&', '\\cr', '\\\\', '\\tabularnewline'].includes(token)
          )
        );
      }
    } while (true);
    parser.endContext();
    lines.push([line]);

    // Append any elements right of the command
    const rhs = parser.scan();
    if (rhs.length > 0) lines.push([rhs]);

    return lines as Argument[];
  },
  createAtom: (options) =>
    new ArrayAtom('lines', options.args as (readonly Atom[])[][], [], {
      // arraystretch: 1.2,
      leftDelim: '.',
      rightDelim: '.',
      columns: [{ align: 'l' }],
      classes: ['ML__multiline_environment'],
      isRoot: true,
      minColumns: 1,
      maxColumns: 1,
      minRows: 1,
    }),
});

/** The `split` environment is used to split a long formula over multiple lines.
 * It is used inside another environment, typically `equation` or `align`.
 * The first column is right-aligned, the second column is left-aligned.
 * The entire construct is numbered as a single equation.
 * The `split*` variant does not number the equation.
```latex
\begin{equation}
\begin{split}
    f(x) &= a + b + c + d \\
         &\quad + e + f + g
\end{split}
\end{equation}
```
 */
defineTabularEnvironment('split', '', makeEnvironment);

// An AMS-Math environment
// %    The \env{gathered} environment is for several lines that are
// %    centered independently.
// From amstex.sty
// \newenvironment{gathered}[1][c]{%
//   \relax\ifmmode\else\nonmatherr@{\begin{gathered}}\fi
//   \null\,%
//   \if #1t\vtop \else \if#1b\vbox \else \vcenter \fi\fi
//   \bgroup\Let@\restore@math@cr
//   \ifinany@\else\openup\jot\fi\ialign
//   \bgroup\hfil\strut@$\m@th\displaystyle##$\hfil\crcr
/** This is the equivalent of the `center` environment, but for math content. `gather` and `gather*` are root environments, `gathered` is a sub-environment */
defineTabularEnvironment(
  ['gather', 'gather*', 'gathered'],
  '',
  makeEnvironment
);

defineTabularEnvironment(
  ['equation', 'equation*', 'subequations'],
  '',
  makeEnvironment
);

// An AMS-Math environment
// See amsmath.dtx:3565
// Note that some versions of AMS-Math have a gap on the left.
// More recent version suppresses that gap, but have an option to turn it
// back on for backward compatibility.
// Note that technically, 'eqnarray' behaves (slightly) differently. However,
// is is generally recommended to avoid using eqnarray and use align instead.
// https://texblog.net/latex-archive/maths/eqnarray-align-environment/
defineRootEnvironment(['align', 'align*', 'eqnarray'], makeEnvironment, {
  tabular: true,
});

defineRootEnvironment(['alignat', 'alignat*'], makeEnvironment, {
  tabular: true,
  params: '{string}',
});

defineRootEnvironment(['flalign', 'flalign*'], makeEnvironment, {
  tabular: true,
});

defineTabularEnvironment(['aligned'], '', makeEnvironment);

// DefineEnvironment('cardinality', '',  function() {
//     const result = {};

//     result.mathstyle = 'textstyle';
//     result.lFence = '|';
//     result.rFence = '|';

//     return result;
// });

defineTabularEnvironment(
  'array',
  '{columns:colspec}',
  (name, array, rowGaps, args) => {
    const colspec = asColspecArgument(args[0]);
    return new ArrayAtom(name, array, rowGaps, {
      columns: colspec ? [...colspec.columns] : defaultColumns(args[0]),
      mathstyleName: 'textstyle',
      environmentParameters: colspec ? `{${colspec.raw}}` : undefined,
    });
  }
);

defineTabularEnvironment(
  [
    'matrix',
    'pmatrix',
    'bmatrix',
    'Bmatrix',
    'vmatrix',
    'Vmatrix',
    'matrix*',
    'pmatrix*',
    'bmatrix*',
    'Bmatrix*',
    'vmatrix*',
    'Vmatrix*',
  ],
  '[columns:colspec]',
  makeEnvironment
);

defineTabularEnvironment(
  ['smallmatrix', 'smallmatrix*'],
  '[columns:colspec]',
  makeEnvironment
);

// \cases is standard LaTeX
// \dcases is from the mathtools package
// \rcases is from the mathtools package
// From amstex.sty:
// \def\cases{\left\{\def\arraystretch{1.2}\hskip-\arraycolsep
//   \array{l@{\quad}l}}
// \def\endcases{\endarray\hskip-\arraycolsep\right.}
// From amsmath.dtx
// \def\env@cases{%
//   \let\@ifnextchar\new@ifnextchar
//   \left\lbrace
//   \def\arraystretch{1.2}%
//   \array{@{}l@{\quad}l@{}}%
defineTabularEnvironment(['cases', 'dcases', 'rcases'], '', makeEnvironment);

// This is a text mode environment
/*
\begin{theorem}
Let $f$ be a function whose derivative exists in every point, then $f$
is a continuous function.
\end{theorem}
*/
// defineEnvironment('theorem', '', function () {
//     return {};
// });

export function makeEnvironment(
  name: Environment,
  content: (readonly Atom[])[][] = [[[]]],
  rowGaps: readonly Dimension[] = [],
  args: readonly (null | Argument)[] = [],
  maxMatrixCols?: number
): ArrayAtom {
  switch (name) {
    case 'math':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
        maxRows: 1,
      });

    case 'displaymath':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
        maxRows: 1,
      });

    case 'center':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ align: 'c' }],
        classes: ['ML__center_environment'],
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
        maxRows: 1,
      });

    case 'multline':
    case 'multline*':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ align: 'm' }],
        leftDelim: '.',
        rightDelim: '.',
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
      });

    case 'split':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ align: 'r' }, { align: 'l' }],
        minColumns: 2,
        minRows: 1,
        isRoot: false,
      });

    case 'gather':
    case 'gather*':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ gap: 0.25 }, { align: 'c' }, { gap: 0 }],
        // colSeparationType: 'gather',
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
        isRoot: true,
        classes: ['ML__gather_environment'],
      });

    case 'gathered':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ gap: 0.25 }, { align: 'c' }, { gap: 0 }],
        // colSeparationType: 'gather',
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
      });

    case 'equation':
    case 'equation*':
    case 'subequations':
      return new ArrayAtom(name, content, rowGaps, {
        columns: [{ align: 'c' }],
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
      });

    case 'aligned': {
      let colCount = 0;
      for (const row of content) colCount = Math.max(colCount, row.length);
      const columns = makeAlignColumns(Math.max(1, Math.ceil(colCount / 2)));

      return new ArrayAtom(name, content, rowGaps, {
        arraycolsep: 0,
        columns,
        // colSeparationType: 'align',
        minColumns: 2,
        minRows: 1,
        isRoot: name !== 'aligned',
      });
    }

    case 'eqnarray':
      return new ArrayAtom(name, content, rowGaps, {
        arraycolsep: 0,
        columns: [{ gap: 0 }, { align: 'r' }, { align: 'c' }, { align: 'l' }],
        minColumns: 3,
        maxColumns: 3,
        minRows: 1,
        isRoot: true,
        classes: ['ML__eqnarray_environment'],
      });

    case 'align':
    case 'align*':
      return new ArrayAtom(name, content, rowGaps, {
        arraycolsep: 0,
        columns: makeAlignColumns(1),
        minColumns: 2,
        maxColumns: 2,
        minRows: 1,
        isRoot: true,
        classes: ['ML__align_environment'],
      });

    case 'alignat':
    case 'alignat*': {
      const pairCount = parseAlignatPairs(args[0]);
      const environmentParameters = `{${pairCount}}`;
      return new ArrayAtom(name, content, rowGaps, {
        arraycolsep: 0,
        columns: makeAlignColumns(pairCount),
        minColumns: pairCount * 2,
        maxColumns: pairCount * 2,
        minRows: 1,
        isRoot: true,
        classes: ['ML__align_environment', 'ML__alignat_environment'],
        environmentParameters,
      });
    }

    case 'flalign':
    case 'flalign*':
      return new ArrayAtom(name, content, rowGaps, {
        arraycolsep: 0,
        columns: makeAlignColumns(1),
        minColumns: 2,
        maxColumns: 2,
        minRows: 1,
        isRoot: true,
        classes: ['ML__align_environment', 'ML__flalign_environment'],
      });

    case 'pmatrix':
    case 'pmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '(',
        rightDelim: ')',
        columns: defaultColumns(args[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'bmatrix':
    case 'bmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '[',
        rightDelim: ']',
        columns: defaultColumns(args[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'Bmatrix':
    case 'Bmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '\\lbrace',
        rightDelim: '\\rbrace',
        columns: defaultColumns(args[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'vmatrix':
    case 'vmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '\\vert',
        rightDelim: '\\vert',
        columns: defaultColumns(args[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'Vmatrix':
    case 'Vmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '\\Vert',
        rightDelim: '\\Vert',
        columns: defaultColumns(args[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'matrix':
    case 'matrix*':
      // Specifying a fence, even a null fence,
      // will prevent the insertion of an initial and final gap
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'textstyle',
        leftDelim: '.',
        rightDelim: '.',
        columns: defaultColumns(args?.[0], maxMatrixCols),
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'smallmatrix':
    case 'smallmatrix*':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: 'scriptstyle',
        columns: defaultColumns(args?.[0], maxMatrixCols),
        colSeparationType: 'small',
        arraystretch: 0.5,
        environmentParameters: optionalColspecParameters(args[0]),
      });

    case 'cases':
    case 'dcases':
      return new ArrayAtom(name, content, rowGaps, {
        mathstyleName: name === 'dcases' ? 'displaystyle' : 'textstyle',
        arraystretch: 1.2,
        leftDelim: '\\lbrace',
        rightDelim: '.',
        columns: casesColumns(),
      });

    case 'rcases':
      return new ArrayAtom(name, content, rowGaps, {
        arraystretch: 1.2,
        leftDelim: '.',
        rightDelim: '\\rbrace',
        columns: casesColumns(),
      });

    case 'lines':
      return new ArrayAtom(name, content, rowGaps, {
        // arraystretch: 1.2,
        leftDelim: '.',
        rightDelim: '.',
        columns: [{ align: 'l' }],
        isRoot: true,
        minColumns: 1,
        maxColumns: 1,
        minRows: 1,
      });
  }

  // 'math'
  return new ArrayAtom(name, content, rowGaps, {
    mathstyleName: 'textstyle',
  });
}

function asColspecArgument(
  arg: null | Argument | undefined
): ColspecArgument | null {
  if (!arg || Array.isArray(arg) || typeof arg !== 'object') return null;
  if (!('columns' in arg) || !Array.isArray(arg.columns)) return null;
  return arg as ColspecArgument;
}

function defaultColumns(
  arg: null | Argument | undefined,
  maxMatrixCols: number = 10
): ColumnFormat[] {
  const colspec = asColspecArgument(arg);
  if (colspec) return [...colspec.columns];
  if (Array.isArray(arg)) return arg as ColumnFormat[];
  return Array(maxMatrixCols).fill({ align: 'c' });
}

function optionalColspecParameters(
  arg: null | Argument | undefined
): string | undefined {
  const colspec = asColspecArgument(arg);
  if (!colspec) return undefined;
  const raw = String(colspec.raw ?? '').trim();
  return raw ? `[${raw}]` : undefined;
}

function parseAlignatPairs(arg: null | Argument | undefined): number {
  if (typeof arg === 'string') {
    const pairCount = Number.parseInt(arg, 10);
    if (Number.isFinite(pairCount) && pairCount > 0) return pairCount;
  }
  return 2;
}

function makeAlignColumns(pairCount: number): ColumnFormat[] {
  const columns: ColumnFormat[] = [{ gap: 0 }];
  const pairs = Math.max(1, Math.floor(pairCount));
  for (let i = 0; i < pairs; i += 1) {
    columns.push({ align: 'r' }, { gap: 0.25 }, { align: 'l' });
    if (i < pairs - 1) columns.push({ gap: 1 });
  }
  columns.push({ gap: 0 });
  return columns;
}

function casesColumns(maxCasesColumns: number = 10): ColumnFormat[] {
  const columns: ColumnFormat[] = [];
  for (let i = 0; i < maxCasesColumns; i++) {
    if (i > 0) columns.push({ gap: 1 });
    columns.push({ align: 'l' });
  }
  return columns;
}
