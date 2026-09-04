import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Next.js development origins', () => {
  it('allows the hosts already approved by MC_ALLOWED_HOSTS', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        "const config = require('./next.config.js'); process.stdout.write(JSON.stringify(config.allowedDevOrigins ?? null))",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MC_ALLOWED_HOSTS: 'localhost, 127.0.0.1, macbook.tailnet.ts.net',
        },
        encoding: 'utf8',
      },
    )

    expect(JSON.parse(output)).toEqual([
      'localhost',
      '127.0.0.1',
      'macbook.tailnet.ts.net',
    ])
  })
})
