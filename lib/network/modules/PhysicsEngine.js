import BarnesHutSolver from "./components/physics/BarnesHutSolver.js";
import Repulsion from "./components/physics/RepulsionSolver.js";
import HierarchicalRepulsion from "./components/physics/HierarchicalRepulsionSolver.js";
import SpringSolver from "./components/physics/SpringSolver.js";
import HierarchicalSpringSolver from "./components/physics/HierarchicalSpringSolver.js";
import CentralGravitySolver from "./components/physics/CentralGravitySolver.js";
import ForceAtlas2BasedRepulsionSolver from "./components/physics/FA2BasedRepulsionSolver.js";
import ForceAtlas2BasedCentralGravitySolver from "./components/physics/FA2BasedCentralGravitySolver.js";
import {
  HSVToHex,
  mergeOptions,
  selectiveNotDeepExtend,
} from "vis-util/esnext";
import { EndPoints } from "./components/edges/index.ts"; // for debugging with _drawForces()

/**
 * The physics engine
 */
class PhysicsEngine {
  /**
   * @param {object} body
   */
  constructor(body) {
    this.body = body;
    this.physicsBody = {
      physicsNodeIndices: [],
      physicsEdgeIndices: [],
      forces: {},
      velocities: {},
    };

    this.physicsEnabled = true;
    this.simulationInterval = 1000 / 60;
    this.requiresTimeout = true;
    this.previousStates = {};
    this.referenceState = {};
    this.freezeCache = {};
    this.renderTimer = undefined;

    // parameters for the adaptive timestep
    this.adaptiveTimestep = false;
    this.adaptiveTimestepEnabled = false;
    this.adaptiveCounter = 0;
    this.adaptiveInterval = 3;

    this.stabilized = false;
    this.startedStabilization = false;
    this.stabilizationIterations = 0;
    this.ready = false; // will be set to true if the stabilize

    // default options
    this.options = {};
    this.defaultOptions = {
      enabled: true,
      barnesHut: {
        theta: 0.5,
        gravitationalConstant: -2000,
        centralGravity: 0.3,
        springLength: 95,
        springConstant: 0.04,
        damping: 0.09,
        avoidOverlap: 0,
      },
      forceAtlas2Based: {
        theta: 0.5,
        gravitationalConstant: -50,
        centralGravity: 0.01,
        springConstant: 0.08,
        springLength: 100,
        damping: 0.4,
        avoidOverlap: 0,
      },
      repulsion: {
        centralGravity: 0.2,
        springLength: 200,
        springConstant: 0.05,
        nodeDistance: 100,
        damping: 0.09,
        avoidOverlap: 0,
      },
      hierarchicalRepulsion: {
        centralGravity: 0.0,
        springLength: 100,
        springConstant: 0.01,
        nodeDistance: 120,
        damping: 0.09,
      },
      maxVelocity: 50,
      minVelocity: 0.75, // px/s
      solver: "barnesHut",
      stabilization: {
        enabled: true,
        iterations: 1000, // maximum number of iteration to stabilize
        updateInterval: 50,
        onlyDynamicEdges: false,
        fit: true,
      },
      timestep: 0.5,
      adaptiveTimestep: true,
      wind: { x: 0, y: 0 },
    };
    Object.assign(this.options, this.defaultOptions);
    this.timestep = 0.5;
    this.layoutFailed = false;

    this.bindEventListeners();
  }

  /**
   * Binds event listeners
   */
  bindEventListeners() {
    this.body.emitter.on("initPhysics", () => {
      this.initPhysics();
    });
    this.body.emitter.on("_layoutFailed", () => {
      this.layoutFailed = true;
    });
    this.body.emitter.on("resetPhysics", () => {
      this.stopSimulation();
      this.ready = false;
    });
    this.body.emitter.on("disablePhysics", () => {
      this.physicsEnabled = false;
      this.stopSimulation();
    });
    this.body.emitter.on("restorePhysics", () => {
      this.setOptions(this.options);
      if (this.ready === true) {
        this.startSimulation();
      }
    });
    this.body.emitter.on("startSimulation", () => {
      if (this.ready === true) {
        this.startSimulation();
      }
    });
    this.body.emitter.on("stopSimulation", () => {
      this.stopSimulation();
    });
    this.body.emitter.on("destroy", () => {
      this.stopSimulation(false);
      this.body.emitter.off();
    });
    this.body.emitter.on("_dataChanged", () => {
      // Nodes and/or edges have been added or removed, update shortcut lists.
      this.updatePhysicsData();
    });

    // debug: show forces
    // this.body.emitter.on("afterDrawing", (ctx) => {this._drawForces(ctx);});
  }

  /**
   * set the physics options
   * @param {object} options
   */
  setOptions(options) {
    if (options !== undefined) {
      if (options === false) {
        this.options.enabled = false;
        this.physicsEnabled = false;
        this.stopSimulation();
      } else if (options === true) {
        this.options.enabled = true;
        this.physicsEnabled = true;
        this.startSimulation();
      } else {
        this.physicsEnabled = true;
        selectiveNotDeepExtend(["stabilization"], this.options, options);
        mergeOptions(this.options, options, "stabilization");

        if (options.enabled === undefined) {
          this.options.enabled = true;
        }

        if (this.options.enabled === false) {
          this.physicsEnabled = false;
          this.stopSimulation();
        }

        const wind = this.options.wind;
        if (wind) {
          if (typeof wind.x !== "number" || Number.isNaN(wind.x)) {
            wind.x = 0;
          }
          if (typeof wind.y !== "number" || Number.isNaN(wind.y)) {
            wind.y = 0;
          }
        }

        // set the timestep
        this.timestep = this.options.timestep;
      }
    }
    this.init();
  }

  /**
   * configure the engine.
   */
  init() {
    let options;
    if (this.options.solver === "forceAtlas2Based") {
      options = this.options.forceAtlas2Based;
      this.nodesSolver = new ForceAtlas2BasedRepulsionSolver(
        this.body,
        this.physicsBody,
        options,
      );
      this.edgesSolver = new SpringSolver(this.body, this.physicsBody, options);
      this.gravitySolver = new ForceAtlas2BasedCentralGravitySolver(
        this.body,
        this.physicsBody,
        options,
      );
    } else if (this.options.solver === "repulsion") {
      options = this.options.repulsion;
      this.nodesSolver = new Repulsion(this.body, this.physicsBody, options);
      this.edgesSolver = new SpringSolver(this.body, this.physicsBody, options);
      this.gravitySolver = new CentralGravitySolver(
        this.body,
        this.physicsBody,
        options,
      );
    } else if (this.options.solver === "hierarchicalRepulsion") {
      options = this.options.hierarchicalRepulsion;
      this.nodesSolver = new HierarchicalRepulsion(
        this.body,
        this.physicsBody,
        options,
      );
      this.edgesSolver = new HierarchicalSpringSolver(
        this.body,
        this.physicsBody,
        options,
      );
      this.gravitySolver = new CentralGravitySolver(
        this.body,
        this.physicsBody,
        options,
      );
    } else {
      // barnesHut
      options = this.options.barnesHut;
      this.nodesSolver = new BarnesHutSolver(
        this.body,
        this.physicsBody,
        options,
      );
      this.edgesSolver = new SpringSolver(this.body, this.physicsBody, options);
      this.gravitySolver = new CentralGravitySolver(
        this.body,
        this.physicsBody,
        options,
      );
    }

    this.modelOptions = options;
  }

  /**
   * initialize the engine
   */
  initPhysics() {
    if (this.physicsEnabled === true && this.options.enabled === true) {
      if (this.options.stabilization.enabled === true) {
        this.stabilize();
      } else {
        this.stabilized = false;
        this.ready = true;
        this.body.emitter.emit("fit", {}, this.layoutFailed); // if the layout failed, we use the approximation for the zoom
        this.startSimulation();
      }
    } else {
      this.ready = true;
      this.body.emitter.emit("fit");
    }
  }

  /**
   * Start the simulation
   */
  startSimulation() {
    if (this.physicsEnabled === true && this.options.enabled === true) {
      this.stabilized = false;

      // when visible, adaptivity is disabled.
      this.adaptiveTimestep = false;

      // this sets the width of all nodes initially which could be required for the avoidOverlap
      this.body.emitter.emit("_resizeNodes");
      if (this.viewFunction === undefined) {
        this.viewFunction = this.simulationStep.bind(this);
        this.body.emitter.on("initRedraw", this.viewFunction);
        this.body.emitter.emit("_startRendering");
      }
    } else {
      this.body.emitter.emit("_redraw");
    }
  }

  /**
   * Stop the simulation, force stabilization.
   * @param {boolean} [emit]
   */
  stopSimulation(emit = true) {
    this.stabilized = true;
    if (emit === true) {
      this._emitStabilized();
    }
    if (this.viewFunction !== undefined) {
      this.body.emitter.off("initRedraw", this.viewFunction);
      this.viewFunction = undefined;
      if (emit === true) {
        this.body.emitter.emit("_stopRendering");
      }
    }
  }

  /**
   * The viewFunction inserts this step into each render loop. It calls the physics tick and handles the cleanup at stabilized.
   *
   */
  simulationStep() {
    // check if the physics have settled
    const startTime = Date.now();
    this.physicsTick();
    const physicsTime = Date.now() - startTime;

    // run double speed if it is a little graph
    if (
      (physicsTime < 0.4 * this.simulationInterval ||
        this.runDoubleSpeed === true) &&
      this.stabilized === false
    ) {
      this.physicsTick();

      // this makes sure there is no jitter. The decision is taken once to run it at double speed.
      this.runDoubleSpeed = true;
    }

    if (this.stabilized === true) {
      this.stopSimulation();
    }
  }

  /**
   * trigger the stabilized event.
   * @param {number} [amountOfIterations]
   * @private
   */
  _emitStabilized(amountOfIterations = this.stabilizationIterations) {
    if (
      this.stabilizationIterations > 1 ||
      this.startedStabilization === true
    ) {
      setTimeout(() => {
        this.body.emitter.emit("stabilized", {
          iterations: amountOfIterations,
        });
        this.startedStabilization = false;
        this.stabilizationIterations = 0;
      }, 0);
    }
  }

  /**
   * Calculate the forces for one physics iteration and move the nodes.
   * @private
   */
  physicsStep() {
    this.gravitySolver.solve();
    this.nodesSolver.solve();
    this.edgesSolver.solve();
    this.moveNodes();
  }

  /**
   * Make dynamic adjustments to the timestep, based on current state.
   *
   * Helper function for physicsTick().
   * @private
   */
  adjustTimeStep() {
    const factor = 1.2; // Factor for increasing the timestep on success.

    // we compare the two steps. if it is acceptable we double the step.
    if (this._evaluateStepQuality() === true) {
      this.timestep = factor * this.timestep;
    } else {
      // if not, we decrease the step to a minimum of the options timestep.
      // if the decreased timestep is smaller than the options step, we do not reset the counter
      // we assume that the options timestep is stable enough.
      if (this.timestep / factor < this.options.timestep) {
        this.timestep = this.options.timestep;
      } else {
        // if the timestep was larger than 2 times the option one we check the adaptivity again to ensure
        // that large instabilities do not form.
        this.adaptiveCounter = -1; // check again next iteration
        this.timestep = Math.max(this.options.timestep, this.timestep / factor);
      }
    }
  }

  /**
   * A single simulation step (or 'tick') in the physics simulation
   * @private
   */
  physicsTick() {
    this._startStabilizing(); // this ensures that there is no start event when the network is already stable.
    if (this.stabilized === true) return;

    // adaptivity means the timestep adapts to the situation, only applicable for stabilization
    if (
      this.adaptiveTimestep === true &&
      this.adaptiveTimestepEnabled === true
    ) {
      // timestep remains stable for "interval" iterations.
      const doAdaptive = this.adaptiveCounter % this.adaptiveInterval === 0;

      if (doAdaptive) {
        // first the big step and revert.
        this.timestep = 2 * this.timestep;
        this.physicsStep();
        this.revert(); // saves the reference state

        // now the normal step. Since this is the last step, it is the more stable one and we will take this.
        this.timestep = 0.5 * this.timestep;

        // since it's half the step, we do it twice.
        this.physicsStep();
        this.physicsStep();

        this.adjustTimeStep();
      } else {
        this.physicsStep(); // normal step, keeping timestep constant
      }

      this.adaptiveCounter += 1;
    } else {
      // case for the static timestep, we reset it to the one in options and take a normal step.
      this.timestep = this.options.timestep;
      this.physicsStep();
    }

    if (this.stabilized === true) this.revert();
    this.stabilizationIterations++;
  }

  /**
   * Nodes and edges can have the physics toggles on or off. A collection of indices is created here so we can skip the check all the time.
   * @private
   */
  updatePhysicsData() {
    this.physicsBody.forces = {};
    this.physicsBody.physicsNodeIndices = [];
    this.physicsBody.physicsEdgeIndices = [];
    const nodes = this.body.nodes;
    const edges = this.body.edges;

    // get node indices for physics
    for (const nodeId in nodes) {
      if (Object.prototype.hasOwnProperty.call(nodes, nodeId)) {
        if (nodes[nodeId].options.physics === true) {
          this.physicsBody.physicsNodeIndices.push(nodes[nodeId].id);
        }
      }
    }

    // get edge indices for physics
    for (const edgeId in edges) {
      if (Object.prototype.hasOwnProperty.call(edges, edgeId)) {
        if (edges[edgeId].options.physics === true) {
          this.physicsBody.physicsEdgeIndices.push(edges[edgeId].id);
        }
      }
    }

    // get the velocity and the forces vector
    for (let i = 0; i < this.physicsBody.physicsNodeIndices.length; i++) {
      const nodeId = this.physicsBody.physicsNodeIndices[i];
      this.physicsBody.forces[nodeId] = { x: 0, y: 0 };

      // forces can be reset because they are recalculated. Velocities have to persist.
      if (this.physicsBody.velocities[nodeId] === undefined) {
        this.physicsBody.velocities[nodeId] = { x: 0, y: 0 };
      }
    }

    // clean deleted nodes from the velocity vector
    for (const nodeId in this.physicsBody.velocities) {
      if (nodes[nodeId] === undefined) {
        delete this.physicsBody.velocities[nodeId];
      }
    }
  }

  /**
   * Revert the simulation one step. This is done so after stabilization, every new start of the simulation will also say stabilized.
   */
  revert() {
    const nodeIds = Object.keys(this.previousStates);
    const nodes = this.body.nodes;
    const velocities = this.physicsBody.velocities;
    this.referenceState = {};

    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      if (nodes[nodeId] !== undefined) {
        if (nodes[nodeId].options.physics === true) {
          this.referenceState[nodeId] = {
            positions: { x: nodes[nodeId].x, y: nodes[nodeId].y },
          };
          velocities[nodeId].x = this.previousStates[nodeId].vx;
          velocities[nodeId].y = this.previousStates[nodeId].vy;
          nodes[nodeId].x = this.previousStates[nodeId].x;
          nodes[nodeId].y = this.previousStates[nodeId].y;
        }
      } else {
        delete this.previousStates[nodeId];
      }
    }
  }

  /**
   * This compares the reference state to the current state
   * @returns {boolean}
   * @private
   */
  _evaluateStepQuality() {
    let dx, dy, dpos;
    const nodes = this.body.nodes;
    const reference = this.referenceState;
    const posThreshold = 0.3;

    for (const nodeId in this.referenceState) {
      if (
        Object.prototype.hasOwnProperty.call(this.referenceState, nodeId) &&
        nodes[nodeId] !== undefined
      ) {
        dx = nodes[nodeId].x - reference[nodeId].positions.x;
        dy = nodes[nodeId].y - reference[nodeId].positions.y;

        dpos = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2));

        if (dpos > posThreshold) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * move the nodes one timestep and check if they are stabilized
   */
  moveNodes() {
    const nodeIndices = this.physicsBody.physicsNodeIndices;
    let maxNodeVelocity = 0;
    let averageNodeVelocity = 0;

    // the velocity threshold (energy in the system) for the adaptivity toggle
    const velocityAdaptiveThreshold = 5;

    for (let i = 0; i < nodeIndices.length; i++) {
      const nodeId = nodeIndices[i];
      const nodeVelocity = this._performStep(nodeId);
      // stabilized is true if stabilized is true and velocity is smaller than vmin --> all nodes must be stabilized
      maxNodeVelocity = Math.max(maxNodeVelocity, nodeVelocity);
      averageNodeVelocity += nodeVelocity;
    }

    // evaluating the stabilized and adaptiveTimestepEnabled conditions
    this.adaptiveTimestepEnabled =
      averageNodeVelocity / nodeIndices.length < velocityAdaptiveThreshold;
    this.stabilized = maxNodeVelocity < this.options.minVelocity;
  }

  /**
   * Calculate new velocity for a coordinate direction
   * @param {number} v  velocity for current coordinate
   * @param {number} f  regular force for current coordinate
   * @param {number} m  mass of current node
   * @returns {number} new velocity for current coordinate
   * @private
   */
  calculateComponentVelocity(v, f, m) {
    const df = this.modelOptions.damping * v; // damping force
    const a = (f - df) / m; // acceleration

    v += a * this.timestep;

    // Put a limit on the velocities if it is really high
    const maxV = this.options.maxVelocity || 1e9;
    if (Math.abs(v) > maxV) {
      v = v > 0 ? maxV : -maxV;
    }

    return v;
  }

  /**
   * Perform the actual step
   * @param {Node.id} nodeId
   * @returns {number} the new velocity of given node
   * @private
   */
  _performStep(nodeId) {
    const node = this.body.nodes[nodeId];
    const force = this.physicsBody.forces[nodeId];

    if (this.options.wind) {
      force.x += this.options.wind.x;
      force.y += this.options.wind.y;
    }

    const velocity = this.physicsBody.velocities[nodeId];

    // store the state so we can revert
    this.previousStates[nodeId] = {
      x: node.x,
      y: node.y,
      vx: velocity.x,
      vy: velocity.y,
    };

    if (node.options.fixed.x === false) {
      velocity.x = this.calculateComponentVelocity(
        velocity.x,
        force.x,
        node.options.mass,
      );
      node.x += velocity.x * this.timestep;
    } else {
      force.x = 0;
      velocity.x = 0;
    }

    if (node.options.fixed.y === false) {
      velocity.y = this.calculateComponentVelocity(
        velocity.y,
        force.y,
        node.options.mass,
      );
      node.y += velocity.y * this.timestep;
    } else {
      force.y = 0;
      velocity.y = 0;
    }

    const totalVelocity = Math.sqrt(
      Math.pow(velocity.x, 2) + Math.pow(velocity.y, 2),
    );
    return totalVelocity;
  }

  /**
   * When initializing and stabilizing, we can freeze nodes with a predefined position.
   * This greatly speeds up stabilization because only the supportnodes for the smoothCurves have to settle.
   * @private
   */
  _freezeNodes() {
    const nodes = this.body.nodes;
    for (const id in nodes) {
      if (Object.prototype.hasOwnProperty.call(nodes, id)) {
        if (nodes[id].x && nodes[id].y) {
          const fixed = nodes[id].options.fixed;
          this.freezeCache[id] = { x: fixed.x, y: fixed.y };
          fixed.x = true;
          fixed.y = true;
        }
      }
    }
  }

  /**
   * Unfreezes the nodes that have been frozen by _freezeDefinedNodes.
   * @private
   */
  _restoreFrozenNodes() {
    const nodes = this.body.nodes;
    for (const id in nodes) {
      if (Object.prototype.hasOwnProperty.call(nodes, id)) {
        if (this.freezeCache[id] !== undefined) {
          nodes[id].options.fixed.x = this.freezeCache[id].x;
          nodes[id].options.fixed.y = this.freezeCache[id].y;
        }
      }
    }
    this.freezeCache = {};
  }

  /**
   * Find a stable position for all nodes
   * @param {number} [iterations]
   */
  stabilize(iterations = this.options.stabilization.iterations) {
    if (typeof iterations !== "number") {
      iterations = this.options.stabilization.iterations;
      console.error(
        "The stabilize method needs a numeric amount of iterations. Switching to default: ",
        iterations,
      );
    }

    if (this.physicsBody.physicsNodeIndices.length === 0) {
      this.ready = true;
      return;
    }

    // enable adaptive timesteps
    this.adaptiveTimestep = true && this.options.adaptiveTimestep;

    // this sets the width of all nodes initially which could be required for the avoidOverlap
    this.body.emitter.emit("_resizeNodes");

    this.stopSimulation(); // stop the render loop
    this.stabilized = false;

    // block redraw requests
    this.body.emitter.emit("_blockRedraw");
    this.targetIterations = iterations;

    // start the stabilization
    if (this.options.stabilization.onlyDynamicEdges === true) {
      this._freezeNodes();
    }
    this.stabilizationIterations = 0;

    setTimeout(() => this._stabilizationBatch(), 0);
  }

  /**
   * If not already stabilizing, start it and emit a start event.
   * @returns {boolean} true if stabilization started with this call
   * @private
   */
  _startStabilizing() {
    if (this.startedStabilization === true) return false;

    this.body.emitter.emit("startStabilizing");
    this.startedStabilization = true;
    return true;
  }

  /**
   * One batch of stabilization
   * @private
   */
  _stabilizationBatch() {
    const running = () =>
      this.stabilized === false &&
      this.stabilizationIterations < this.targetIterations;

    const sendProgress = () => {
      this.body.emitter.emit("stabilizationProgress", {
        iterations: this.stabilizationIterations,
        total: this.targetIterations,
      });
    };

    if (this._startStabilizing()) {
      sendProgress(); // Ensure that there is at least one start event.
    }

    let count = 0;
    while (running() && count < this.options.stabilization.updateInterval) {
      this.physicsTick();
      count++;
    }

    sendProgress();

    if (running()) {
      setTimeout(this._stabilizationBatch.bind(this), 0);
    } else {
      this._finalizeStabilization();
    }
  }

  /**
   * Wrap up the stabilization, fit and emit the events.
   * @private
   */
  _finalizeStabilization() {
    this.body.emitter.emit("_allowRedraw");
    if (this.options.stabilization.fit === true) {
      this.body.emitter.emit("fit");
    }

    if (this.options.stabilization.onlyDynamicEdges === true) {
      this._restoreFrozenNodes();
    }

    this.body.emitter.emit("stabilizationIterationsDone");
    this.body.emitter.emit("_requestRedraw");

    if (this.stabilized === true) {
      this._emitStabilized();
    } else {
      this.startSimulation();
    }

    this.ready = true;
  }

  //---------------------------  DEBUGGING BELOW  ---------------------------//

  /**
   * Debug function that display arrows for the forces currently active in the network.
   *
   * Use this when debugging only.
   * @param {CanvasRenderingContext2D} ctx
   * @private
   */
  _drawForces(ctx) {
    for (let i = 0; i < this.physicsBody.physicsNodeIndices.length; i++) {
      const index = this.physicsBody.physicsNodeIndices[i];
      const node = this.body.nodes[index];
      const force = this.physicsBody.forces[index];
      const factor = 20;
      const colorFactor = 0.03;
      const forceSize = Math.sqrt(Math.pow(force.x, 2) + Math.pow(force.x, 2));

      const size = Math.min(Math.max(5, forceSize), 15);
      const arrowSize = 3 * size;

      const color = HSVToHex(
        (180 - Math.min(1, Math.max(0, colorFactor * forceSize)) * 180) / 360,
        1,
        1,
      );

      const point = {
        x: node.x + factor * force.x,
        y: node.y + factor * force.y,
      };

      ctx.lineWidth = size;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();

      const angle = Math.atan2(force.y, force.x);
      ctx.fillStyle = color;
      EndPoints.draw(ctx, {
        type: "arrow",
        point: point,
        angle: angle,
        length: arrowSize,
      });
      ctx.fill();
    }
  }
}

export default PhysicsEngine;
