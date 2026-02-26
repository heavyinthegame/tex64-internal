import type { AtomJson } from 'core/types';
import { Box } from '../core/box';
import type { Context } from '../core/context';
import { Atom } from '../core/atom-class';

const normalizePreview = (latex: string): string => {
  const compact = String(latex ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= 44) return compact;
  return `${compact.slice(0, 41)}...`;
};

/**
 * Represents a command that is not currently defined by MathLive.
 * It is rendered as a neutral badge and preserves the verbatim LaTeX.
 */
export class UnknownCommandAtom extends Atom {
  readonly argumentLatex: string;

  constructor(command: string, argumentLatex = '') {
    super({ type: 'error', value: command, command, mode: 'math' });
    this.argumentLatex = argumentLatex;
    this.verbatimLatex = `${command}${argumentLatex}`;
  }

  static fromJson(json: AtomJson): UnknownCommandAtom {
    const command = String(json.command ?? json.value ?? '');
    const argumentLatex = String(json.argumentLatex ?? '');
    const result = new UnknownCommandAtom(command, argumentLatex);
    if (typeof json.verbatimLatex === 'string')
      result.verbatimLatex = json.verbatimLatex;
    return result;
  }

  toJson(): AtomJson {
    return {
      ...super.toJson(),
      unknownCommand: true,
      argumentLatex: this.argumentLatex,
    };
  }

  render(context: Context): Box {
    const displayName = this.command.startsWith('\\')
      ? this.command.slice(1)
      : this.command;
    const commandName = new Box(displayName, {
      classes: 'ML__tex64-unknown-command-name',
    });

    const preview = normalizePreview(this.argumentLatex);
    const children = [commandName];
    if (preview) {
      children.push(
        new Box(preview, {
          classes: 'ML__tex64-unknown-command-args',
        })
      );
    }

    const result = new Box(children, {
      classes: 'ML__tex64-unknown-command',
    });

    if (this.caret) result.caret = this.caret;
    return this.bind(context, result);
  }
}
