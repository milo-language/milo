// Build-time loader for the tour: renders each lesson's code with the same Shiki
// grammar and themes as every other ```milo fence on the site, so the page ships
// highlighted HTML instead of an editor.
import path from 'node:path'
import { createMarkdownRenderer } from 'vitepress'
import { miloGrammar } from '../miloGrammar'
import { lessons } from './tourLessons'

export interface TourLesson {
  title: string
  file: string
  cmd: string
  descHtml: string
  takeHtml: string
  codeHtml: string
  out: string
  fails: boolean
}

declare const data: TourLesson[]
export { data }

export default {
  watch: ['./tourLessons.ts'],
  async load(): Promise<TourLesson[]> {
    const md = await createMarkdownRenderer(path.resolve(__dirname, '../..'), { languages: [miloGrammar] }, '/milo/')
    return lessons.map((l) => ({
      title: l.title,
      file: l.file,
      cmd: `milo run ${l.debug ? '--debug ' : ''}${l.file}`,
      descHtml: md.renderInline(l.desc),
      takeHtml: md.renderInline(l.take),
      codeHtml: md.render('```milo\n' + l.code + '\n```\n'),
      out: l.out.join('\n'),
      fails: !!l.fails,
    }))
  },
}
