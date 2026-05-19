import { marker } from "./utils";

const users = [
  { id: 1, active: false },
  { id: 2, active: true },
  { id: 3, active: false }
];

const ids = [1, 2, 3, 4];
const userMap = new Map(users.map((user) => [user.id, user]));

function refreshMetrics() {
  // Better than frequent console logging in a hot path: keep side effects minimal.
  return marker;
}

function loadDashboardEfficiently() {
  // Greener than filter().length > 0 because some() stops at the first match.
  const hasActiveUsers = users.some((user) => user.active);

  // Greener than nested loops because lookups are indexed.
  for (const id of ids) {
    const user = userMap.get(id);
    if (user) {
      refreshMetrics();
    }
  }

  // Greener than fetch inside a loop because requests are batched.
  void fetch(`/api/users?ids=${ids.join(",")}`);

  // Greener than aggressive polling because it avoids constant wakeups.
  setTimeout(() => {
    refreshMetrics();
  }, 5000);

  return hasActiveUsers;
}

loadDashboardEfficiently();
