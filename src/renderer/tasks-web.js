'use strict';
// Browser adapter for the same task UI used by Electron.
async function request(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-CLI-Accounts': 'dashboard', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
window.api = {
  state: () => request('/api/state'), onState: () => {},
  tasksBrowseFolders: path => request('/api/folders?path=' + encodeURIComponent(path || '')),
  tasksStart: () => request('/api/health'), tasksBindings: () => request('/api/bindings'),
  tasksList: () => request('/api/tasks'), tasksGet: id => request(`/api/tasks/${encodeURIComponent(id)}`),
  tasksOutput: (id, attemptId) => request(`/api/tasks/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attemptId)}/output`),
  tasksSubmit: input => request('/api/tasks', input),
  tasksCancel: id => request(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
  tasksRespond: (id, message) => request(`/api/tasks/${encodeURIComponent(id)}/respond`, { message }),
  tasksAck: (id, version) => request(`/api/tasks/${encodeURIComponent(id)}/ack`, { version }),
};
