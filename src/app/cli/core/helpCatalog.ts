export const sections: [string, [string, string][]][] = [
  [
    'Workspace',
    [
      ['project', 'List projects and find their IDs'],
      ['space', 'List and inspect project spaces'],
      ['node', 'Create, read, update and delete canvas nodes'],
      ['canvas', 'Focus nodes and spaces on the canvas'],
      ['agent', 'List, inspect, prompt, wait for and read agents'],
    ],
  ],
  [
    'Introspection',
    [
      ['skill', 'Print the bundled agent usage guide'],
      ['whoami', 'Show your caller identity and permission scope'],
      ['context', 'Orient yourself in a project and space'],
      ['api', 'Discover operations, inspect input schemas and invoke the Control Surface'],
    ],
  ],
  [
    'Runtime',
    [
      ['ping', 'Check whether the Control Surface responds'],
      ['status', 'Show protocol, app version and instance identity'],
      ['worker', 'Start, inspect and stop local workers'],
      ['runtime', 'Inspect, verify and prepare managed runtimes'],
      ['endpoint', 'Register and manage remote worker connections'],
      ['mount', 'Connect project folders to worker endpoints'],
      ['fs', 'Read, write and inspect files through the Control Surface'],
      ['worktree', 'List, create and archive Git worktrees'],
      ['session', 'Run agents and inspect or stop their sessions'],
      ['pty', 'Start and attach to terminal sessions'],
    ],
  ],
  ['Plugins', [['plugin', 'Discover, install and manage plugins']]],
]
export const commandExamples: Record<string, string[]> = {
  ping: ['eclipse-code ping', 'eclipse-code --user-data ./profile ping'],
  status: ['eclipse-code status', 'eclipse-code status --pretty'],
  'project list': ['eclipse-code project list', 'eclipse-code project list --fields id,name'],
  'space list': ['eclipse-code space list', 'eclipse-code space list --project project-123'],
  'space get': [
    'eclipse-code space get --space space-123',
    'eclipse-code space get --space space-123 --pretty',
  ],
  'node list': [
    'eclipse-code node list --space space-123',
    'eclipse-code node list --space space-123 --fields nodes.id,nodes.title',
  ],
  'node get': [
    'eclipse-code node get --node node-123',
    'eclipse-code node get --node node-123 --fields node.id,node.title',
  ],
  'node delete': [
    'eclipse-code node delete --node node-123',
    'eclipse-code --user-data ./profile node delete --node node-123',
  ],
  'canvas focus node': [
    'eclipse-code canvas focus node --node node-123',
    'eclipse-code --user-data ./profile canvas focus node --node node-123',
  ],
  'canvas focus space': [
    'eclipse-code canvas focus space --space space-123',
    'eclipse-code canvas focus space --space-name "Sprint planning" --project project-123',
  ],
  'api ops': [
    'eclipse-code api ops --domains',
    'eclipse-code api ops --search create',
    'eclipse-code api ops --prefix node --fields id,cliCommand',
    'eclipse-code api ops --kind query --contract schema',
  ],
  'api schema': [
    'eclipse-code api schema node.create',
    'eclipse-code api schema node.create --variant note',
    'eclipse-code api schema system.operation.describe --pretty',
  ],
  'api call': [
    'eclipse-code api call project.list',
    'eclipse-code api call node.create --input-file ./new-note.json',
  ],
}
