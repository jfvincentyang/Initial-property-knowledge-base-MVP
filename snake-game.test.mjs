import assert from "node:assert/strict";

import {
  createInitialState,
  placeFood,
  queueDirection,
  stepGame,
} from "./snake-game.js";

runTest("moves forward one cell in the current direction", () => {
  const state = {
    ...createInitialState(() => 0),
    hasStarted: true,
  };

  const nextState = stepGame(state, () => 0);

  assert.deepEqual(nextState.snake[0], { x: 9, y: 8 });
  assert.equal(nextState.snake.length, 3);
  assert.equal(nextState.score, 0);
});

runTest("grows and increments score when food is eaten", () => {
  const state = {
    ...createInitialState(() => 0),
    food: { x: 9, y: 8 },
    hasStarted: true,
  };

  const nextState = stepGame(state, () => 0);

  assert.equal(nextState.score, 1);
  assert.equal(nextState.snake.length, 4);
  assert.deepEqual(nextState.snake[0], { x: 9, y: 8 });
  assert.notDeepEqual(nextState.food, { x: 9, y: 8 });
});

runTest("marks the game over when the snake hits a wall", () => {
  const state = {
    ...createInitialState(() => 0),
    snake: [{ x: 15, y: 8 }],
    direction: "right",
    pendingDirection: "right",
    hasStarted: true,
  };

  const nextState = stepGame(state, () => 0);

  assert.equal(nextState.isGameOver, true);
});

runTest("prevents immediate reversal into the opposite direction", () => {
  const state = createInitialState(() => 0);

  const nextState = queueDirection(state, "left");

  assert.equal(nextState.pendingDirection, "right");
});

runTest("allows moving into the previous tail position", () => {
  const state = {
    gridSize: 16,
    snake: [
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
      { x: 1, y: 2 },
    ],
    direction: "right",
    pendingDirection: "up",
    food: { x: 10, y: 10 },
    score: 0,
    isGameOver: false,
    hasStarted: true,
  };

  const nextState = stepGame(state, () => 0);

  assert.equal(nextState.isGameOver, false);
  assert.deepEqual(nextState.snake[0], { x: 2, y: 1 });
});

runTest("places food only on open cells", () => {
  const snake = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];

  const food = placeFood(snake, 2, () => 0);

  assert.deepEqual(food, { x: 1, y: 1 });
});

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
