// Report only this installation; never search/copy another installation's credentials.
export function accountRoute(store, runtime = {}) {
  const state = store.load();
  return {
    installation: { edition: runtime.edition ?? null, dataRoot: runtime.dataRoot ?? null },
    execution: { profileSelection: 'explicit-per-task', changesActiveAccount: false, fallbackToActive: false },
    accounts: ['claude', 'codex'].flatMap(tool => (state[tool]?.profiles ?? []).map(profileId => ({ tool, profileId }))),
  };
}
export function assertParticipants(participants, store, runtime = {}) {
  const route = accountRoute(store, runtime);
  for (const participant of participants ?? []) {
    if (!route.accounts.some(a => a.tool === participant.tool && a.profileId === participant.profileId)) {
      const error = new Error(`Requested profile is not available in this installation: ${participant.tool}/${participant.profileId}. Data root: ${route.installation.dataRoot ?? 'unknown'}. Inspect connect and the intended installation's CLI help/list, then use explicit run --profile if appropriate. Never switch the global active account, change Gateway configuration, copy credentials, or substitute another profile.`);
      error.code = 'PROFILE_NOT_IN_INSTALLATION';
      error.installation = route.installation;
      throw error;
    }
  }
}
