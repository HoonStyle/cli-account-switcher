'use strict';
async function run(args) {
  const flags = new Set(args.filter(a => a.startsWith('--')));
  if ([...flags].some(flag => !['--json', '--shared-login'].includes(flag))) throw Error('지원하지 않는 Antigravity 옵션입니다.');
  const [command = 'list', query] = args.filter(a => !a.startsWith('--'));
  const manager = require('./antigravity').manager();
  let result;
  if (command === 'list') result = manager.snapshot();
  else if (command === 'check') result = await manager.check();
  else if (command === 'usage' || command === 'quota') result = await manager.refreshUsage();
  else if (command === 'save' || command === 'add') result = await manager.save(query);
  else if (command === 'use' || command === 'switch') {
    if (!flags.has('--shared-login')) throw Error('앱·IDE·CLI의 공용 로그인을 변경합니다. 모두 종료한 뒤 use <name> --shared-login으로 전환하세요.');
    result = await manager.activate(query);
  } else if (command === 'remove' || command === 'rm') result = await manager.remove(query);
  else if (command === 'recover') result = await manager.recover();
  else if (command === 'login') {
    console.log('공식 agy를 실행해 로그인한 뒤 cli-accounts antigravity save <name>으로 저장하세요. 다른 계정으로 로그인하기 전 현재 계정을 먼저 저장하세요.');
    return;
  } else throw Error('사용법: cli-accounts antigravity list|check|usage|save <name>|use <name> --shared-login|remove <name>|recover');
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('Antigravity · 공용 로그인 (계정별 동시 실행·관리형 위임 미지원)');
    if (result.error) throw Error(result.error);
    console.log(`현재 로그인: ${result.checkedAt ? result.current?.email || '없음' : '미확인 · check로 확인'}`);
    for (const account of result.accounts) console.log(`  ${account.id === result.current?.id ? '*' : ' '} ${account.label} · ${account.email}`);
    if (result.usage) {
      console.log('현재 공용 로그인 사용량 · 공식 agy');
      for (const group of result.usage.groups) console.log(`  ${group.name}: ${group.buckets.map(b => `${b.label} ${Math.round(b.remainingPercent)}% 남음${b.resetsAt ? ' · 리셋 ' + new Date(b.resetsAt * 1000).toLocaleString() : ''}`).join(' / ')}`);
    }
    if (result.recoveryRequired) console.log('전환 복구 필요: cli-accounts antigravity recover');
  }
}
module.exports = { run };
