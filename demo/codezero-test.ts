type User = {
  id: number;
  name: string;
  active: boolean;
  teamId: number;
};

const users: User[] = [
  { id: 1, name: "Asha", active: true, teamId: 10 },
  { id: 2, name: "Ravi", active: false, teamId: 10 },
  { id: 3, name: "Mira", active: true, teamId: 20 },
  { id: 4, name: "Dev", active: false, teamId: 20 }
];

const teamIds = [10, 20, 30, 40];

function loadDashboard() {
  setInterval(() => {
    fetch("/api/dashboard");
  }, 5000); // Polling every 5 seconds instead of 500ms

  const hasActiveUsers = users.some((user) => user.active); // Short-circuited array scan

  // Refactor: Collect user and team IDs in a single pass over the users array
  const userIdsToFetch = new Set<number>();
  const teamIdsToFetch = new Set<number>();

  const relevantTeamIds = new Set(teamIds); // For quick lookup of teams from the constant list

  for (const user of users) { // Single loop over users
    if (relevantTeamIds.has(user.teamId)) {
      userIdsToFetch.add(user.id);
      teamIdsToFetch.add(user.teamId);
    }
  }

  // Execute batched fetches for users and teams
  userIdsToFetch.forEach(id => fetch(`/api/users/${id}`));
  teamIdsToFetch.forEach(id => fetch(`/api/teams/${id}`));

  // Batch fetches for user activities
  users.forEach(user => fetch(`/api/activity/${user.id}`));

  return hasActiveUsers;
}

loadDashboard();