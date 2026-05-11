/**
 * Tests for NotifyScheduler.
 *
 * Exercises throttle, flush, unsubscribe, dispose, and listener-error
 * isolation. Uses short windows so the suite stays fast.
 */

import { NotifyScheduler } from '../orchestrator/notify.js';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`Assertion failed: ${label}`);
}

async function main(): Promise<void> {
  // ─── Test 1: throttle coalesces bursts ──────────────────────

  console.log('Test 1: schedule() coalesces a burst...');
  {
    const sched = new NotifyScheduler({ throttleMs: 50 });
    let calls = 0;
    sched.subscribe(() => { calls += 1; });

    for (let i = 0; i < 20; i++) sched.schedule();
    await sleep(100);

    assert(calls === 1, `expected 1 call, got ${calls}`);
    sched.dispose();
    console.log('  ✓ 20 schedules → 1 fire');
  }

  // ─── Test 2: flush cancels pending + fires now ──────────────

  console.log('Test 2: flush() cancels pending and fires immediately...');
  {
    const sched = new NotifyScheduler({ throttleMs: 200 });
    let calls = 0;
    sched.subscribe(() => { calls += 1; });

    sched.schedule();
    sched.flush();
    await sleep(50);
    assert(calls === 1, `after flush expected 1 call, got ${calls}`);

    // Make sure the cancelled timer doesn't fire a second time.
    await sleep(250);
    assert(calls === 1, `timer must be cancelled, got ${calls}`);

    sched.dispose();
    console.log('  ✓ flush fires once, cancels pending timer');
  }

  // ─── Test 3: subscribe/unsubscribe ──────────────────────────

  console.log('Test 3: unsubscribe stops notifications...');
  {
    const sched = new NotifyScheduler({ throttleMs: 20 });
    let calls = 0;
    const unsub = sched.subscribe(() => { calls += 1; });

    sched.flush();
    assert(calls === 1, 'fires before unsubscribe');

    unsub();
    sched.flush();
    assert(calls === 1, `no fire after unsubscribe (got ${calls})`);

    sched.dispose();
    console.log('  ✓ unsubscribe stops further fires');
  }

  // ─── Test 4: a throwing listener doesn't kill the scheduler ──

  console.log('Test 4: throwing listener is isolated...');
  {
    const sched = new NotifyScheduler({ throttleMs: 10 });
    let goodCalls = 0;
    sched.subscribe(() => { throw new Error('boom'); });
    sched.subscribe(() => { goodCalls += 1; });

    sched.flush();
    assert(goodCalls === 1, `good listener must still fire (got ${goodCalls})`);

    sched.flush();
    assert(goodCalls === 2, 'scheduler still works after throw');

    sched.dispose();
    console.log('  ✓ throw in one listener does not break others');
  }

  // ─── Test 5: dispose stops everything ───────────────────────

  console.log('Test 5: dispose cancels timer and clears listeners...');
  {
    const sched = new NotifyScheduler({ throttleMs: 20 });
    let calls = 0;
    sched.subscribe(() => { calls += 1; });

    sched.schedule();
    sched.dispose();
    await sleep(60);
    assert(calls === 0, `no fire after dispose (got ${calls})`);
    console.log('  ✓ dispose cancels pending + detaches listeners');
  }

  console.log('\n✅ All notify-scheduler tests passed!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
