export const GRID_SIZE = 16;

export const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITES = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

export function createInitialState(randomFn = Math.random) {
  const snake = [
    { x: 8, y: 8 },
    { x: 7, y: 8 },
    { x: 6, y: 8 },
  ];

  return {
    gridSize: GRID_SIZE,
    snake,
    direction: "right",
    pendingDirection: "right",
    food: placeFood(snake, GRID_SIZE, randomFn),
    score: 0,
    isGameOver: false,
    hasStarted: false,
  };
}

export function queueDirection(state, nextDirection) {
  if (!DIRECTIONS[nextDirection]) {
    return state;
  }

  if (OPPOSITES[state.direction] === nextDirection && state.snake.length > 1) {
    return state;
  }

  return {
    ...state,
    pendingDirection: nextDirection,
    hasStarted: true,
  };
}

export function stepGame(state, randomFn = Math.random) {
  if (state.isGameOver) {
    return state;
  }

  const direction = state.pendingDirection;
  const delta = DIRECTIONS[direction];
  const head = state.snake[0];
  const nextHead = {
    x: head.x + delta.x,
    y: head.y + delta.y,
  };
  const foundFood = positionsEqual(nextHead, state.food);
  const bodyToCheck = foundFood ? state.snake : state.snake.slice(0, -1);

  const hitsWall =
    nextHead.x < 0 ||
    nextHead.y < 0 ||
    nextHead.x >= state.gridSize ||
    nextHead.y >= state.gridSize;

  if (hitsWall || hitsSnake(nextHead, bodyToCheck)) {
    return {
      ...state,
      direction,
      isGameOver: true,
      hasStarted: true,
    };
  }

  const nextSnake = [nextHead, ...state.snake];

  if (!foundFood) {
    nextSnake.pop();
  }

  return {
    ...state,
    snake: nextSnake,
    direction,
    pendingDirection: direction,
    food: foundFood ? placeFood(nextSnake, state.gridSize, randomFn) : state.food,
    score: foundFood ? state.score + 1 : state.score,
    hasStarted: true,
  };
}

export function placeFood(snake, gridSize, randomFn = Math.random) {
  const occupied = new Set(snake.map((segment) => `${segment.x},${segment.y}`));
  const available = [];

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const key = `${x},${y}`;
      if (!occupied.has(key)) {
        available.push({ x, y });
      }
    }
  }

  if (available.length === 0) {
    return null;
  }

  const index = Math.floor(randomFn() * available.length);
  return available[index];
}

export function positionsEqual(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y;
}

function hitsSnake(position, snake) {
  return snake.some((segment) => positionsEqual(segment, position));
}
