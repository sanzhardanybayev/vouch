import { add } from './calc'
import { greet } from './util'

export function helper(): number {
  return add(2, 3)
}

export function run(): string {
  return greet(String(helper()))
}
