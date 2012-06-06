/*
 * lib/worker/worker.js: job worker implementation
 */

/*
 * A Marlin deployment includes a fleet of job workers that are responsible for
 * managing the distributed execution of Marlin jobs.  The core of each worker
 * is a loop that looks for new and abandoned jobs, divides each job into chunks
 * called task groups, assigns these task groups to individual compute nodes,
 * monitors each node's progress, and collects the results.  While individual
 * workers are not resource-intensive, a fleet is used to support very large
 * numbers of jobs concurrently and to provide increased availability in the
 * face of failures and partitions.
 *
 * Jobs are represented as records within Moray instances, which are themselves
 * highly available.  At any given time, a job is assigned to at most one
 * worker, and this assignment is stored in the job's record in Moray.  Workers
 * do not maintain any state which cannot be reconstructed from the state stored
 * in Moray, which makes it possible for workers to pick up jobs abandoned by
 * other workers which have failed or become partitioned.  In order to detect
 * such failures, workers must update job records on a regular basis (even if
 * there's no substantial state change).  Job records which have not been
 * updated for too long will be grabbed up by idle workers.
 *
 * All communication among the workers, compute nodes, and the web tier (through
 * which jobs are submitted and monitored) goes through Moray.  The Moray
 * interface is abstracted out so that it can be replaced with an alternative
 * mechanism for testing.
 */

/*
 * Implementation TODO:
 *    o For testing, we need a way to add keys and jobs to the mock moray.
 *    o Need work on dropJob.  It shouldn't remove all trace of the job unless
 *      there are no ongoing async activities for it.  If there are, it should
 *      move it to a "dropped" list and abort all such activities.
 *    o Assigning jobs to the worker should use test-and-set, rather than a
 *      simple objectPut.
 *    o We should be validating records read from Moray (job records and task
 *      groups).
 *    o We shouldn't try to assign *all* found jobs to ourselves -- just up to
 *      some limit.
 *    o Add timeouts for retries that happen as a result of calling job tick().
 *    o All async events should record that they're happening somewhere for
 *      debugging.
 */

var mod_assert = require('assert');
var mod_os = require('os');

var mod_bunyan = require('bunyan');
var mod_jsprim = require('jsprim');
var mod_kang = require('kang');
var mod_uuid = require('node-uuid');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var mod_moray = require('./moray');

var mwConf = {
    'jobsBucket': 'marlinJobs',
    'taskGroupsBucket': 'marlinTaskGroups',
    'findInterval': 5 * 1000,	/* how often to ping Moray for new jobs (ms) */
    'tickInterval': 1 * 1000	/* how often to re-evalute state */
};


/*
 * Manages jobs owned by a single Marlin worker.  Most job management actually
 * happens in the mwJobState class below.  Arguments for this class include:
 *
 *    uuid	Unique identifier for this worker instance
 *
 *    moray	Moray interface
 *
 *    log	Bunyan-style logger instance
 *
 * The worker itself doesn't do much except accept incoming jobs, which are
 * managed by separate mwJobState objects.  The worker also manages a global
 * timeout that fires every mwConf['tickInterval'] milliseconds, which causes
 * each job's state to be reevaluated.
 */
function mwWorker(args)
{
	mod_assert.equal(typeof (args['uuid']), 'string');
	mod_assert.equal(typeof (args['moray']), 'object');
	mod_assert.equal(typeof (args['log']), 'object');

	/* immutable state */
	this.mw_uuid = args['uuid'];
	this.mw_interval = mwConf['tickInterval'];

	/* helper objects */
	this.mw_log = args['log'].child({ 'worker': this.mw_uuid });
	this.mw_moray = args['moray'];
	this.mw_moray.on('job', this.onJob.bind(this));

	/* dynamic state */
	this.mw_jobs = {};			/* all jobs, by jobId */
	this.mw_timeout = undefined;		/* JS timeout handle */
	this.mw_worker_start = undefined;	/* time worker started */
	this.mw_tick_start = undefined;		/* time last tick started */
	this.mw_tick_done = undefined;		/* time last tick finished */
}

/*
 * Start the worker by scheduling an immediate tick.
 */
mwWorker.prototype.start = function ()
{
	var worker = this;
	this.mw_worker_start = new Date();
	this.mw_log.info('starting worker');
	process.nextTick(function workerTickStart() { worker.tick(); });
};

/*
 * Schedule the next tick at the appropriate interval in the future.
 */
mwWorker.prototype.setTimer = function ()
{
	var worker = this;

	mod_assert.ok(this.mw_timeout === undefined);
	this.mw_timeout = setTimeout(
	    function workerTickTick() { worker.tick(); }, this.mw_interval);
};

/*
 * The heart of the job worker, this function tells our Moray interface to scan
 * for new unassigned jobs and then invokes "tick" on each of our existing jobs
 * to reevaluate their states.
 */
mwWorker.prototype.tick = function ()
{
	this.mw_tick_start = new Date();
	this.mw_timeout = undefined;

	this.mw_moray.findUnassignedJobs();

	mod_jsprim.forEachKey(this.mw_jobs, function (_, job) { job.tick(); });

	this.mw_tick_done = new Date();
	this.setTimer();
};

/*
 * Invoked when our Moray interface finds an unassigned job for us to pick up.
 */
mwWorker.prototype.onJob = function (job)
{
	var jobid = job['jobId'];
	var log = this.mw_log;

	if (this.mw_jobs.hasOwnProperty(jobid)) {
		if (this.mw_jobs[jobid].js_state == 'unassigned')
			/* We're already trying to take this job. */
			return;

		/*
		 * It shouldn't be possible to find a job here that we already
		 * thought we owned because we'll prematurely drop any jobs for
		 * which our lock has expired.  But if this happens, drop the
		 * job now and try to take it again.
		 */
		log.warn('found unassigned job "%s" that we thought we owned',
		    jobid);
		this.dropJob(jobid);
		mod_assert.ok(!this.mw_jobs.hasOwnProperty(jobid));
	}

	var newjob = new mwJobState({
	    'job': job,
	    'log': this.mw_log,
	    'moray': this.mw_moray,
	    'worker_uuid': this.mw_uuid
	});

	this.mw_jobs[jobid] = newjob;
	newjob.tick();
};

mwWorker.prototype.dropJob = function (jobid)
{
	delete (this.mw_jobs[jobid]);
};


/*
 * Manages a single job.  Jobs run through the following state machine:
 *
 *                              +
 *                              | Discover new job (or abandoned job)
 *                              v
 *                         UNASSIGNED
 *                              |
 *                              | Successfully write assignment record
 *                              v
 *                        UNINITIALIZED
 *                              |
 *                              | Finish retrieving task groups
 *                              v
 *                  +---->  PLANNING
 *  Compute node    |           |
 *  times out or    |           | Compute and write task group assignments
 *  phase completes |           v
 *                  +-----   RUNNING
 *                              |
 *                              | Last phase completes,
 *                              | job encounters fatal failure, or
 *                              | job dropped because lock was lost
 *                              v
 *                            DONE
 */
function mwJobState(args)
{
	mod_assert.equal(typeof (args['job']), 'object');
	mod_assert.equal(typeof (args['log']), 'object');
	mod_assert.equal(typeof (args['moray']), 'object');
	mod_assert.equal(typeof (args['worker_uuid']), 'string');

	this.js_job = args['job'];
	this.js_log = args['log'].child({ 'job': this.js_jobid });
	this.js_moray = args['moray'];
	this.js_worker_uuid = args['worker_uuid'];

	this.js_jobid = this.js_job['jobId'];
	this.js_state = 'unassigned';
	this.js_state_time = new Date();
	this.js_pending_start = undefined;

	this.js_phasei = undefined;		/* current phase */
	this.js_phases = new Array(this.js_job['phases'].length);

	for (var i = 0; i < this.js_job['phases'].length; i++)
		this.js_phases[i] = {
		    p_input: [],
		    p_groups: {},
		    p_keys_unassigned: {}
		};
}

/*
 * "tick" is the heart of each job: it's invoked once per tickInterval and
 * examines the current state of the job to figure out what to do next.  The
 * rest of this class consists of functions that are invoked from a given state
 * in order to move to another state.  Most of these are asynchronous and set
 * js_pending_start while the asynchronous operation is ongoing.
 */
mwJobState.prototype.tick = function ()
{
	/*
	 * If there's already an asynchronous operation pending, we don't have
	 * any more work to do.  The operations that set this must use timeouts
	 * to ensure we don't get stuck here.
	 */
	if (this.js_pending_start !== undefined)
		return;

	switch (this.js_state) {
	case 'unassigned':
		this.jobAssign();
		break;

	case 'uninitialized':
		this.jobRestore();
		break;

	case 'planning':
		this.taskGroupAssign();
		break;

	case 'running':
		this.js_moray.watchTaskGroups();
		break;

	default:
		var err = new mod_verror.VError(
		    'found job in invalid state: %j', this.js_state);
		this.js_log.fatal(err);
		throw (err);
	}
};

/*
 * From the "unassigned" state, attempt to bring the job to "uninitialized" by
 * updating the Moray job record with worker == our uuid.
 */
mwJobState.prototype.jobAssign = function ()
{
	var job = this;
	var jobid = this.js_jobid;
	var log = this.js_log;
	var record;

	mod_assert.equal(this.js_state, 'unassigned');
	mod_assert.ok(this.js_pending_start === undefined);

	this.js_pending_start = new Date();
	jobid = this.js_jobid;

	if (this.js_job['worker']) {
		log.info('attempting to steal job %s from %s',
		    jobid, this.js_job['worker']);
	} else {
		log.info('attempting to take unassigned job %s', jobid);
	}

	record = Object.create(this.js_job);
	record['worker'] = this.js_worker_uuid;

	this.js_moray.assignJob(record, function (err) {
		job.js_pending_start = undefined;

		if (err) {
			log.warn('failed to assign job %s', jobid);
			/* XXX drop this job entirely, rather than retry */
			return;
		}

		job.js_log.info('assigned job %s', jobid);
		mod_assert.equal(job.js_state, 'unassigned');
		job.js_state = 'uninitialized';
		job.js_state_time = new Date();
		job.tick();
	});
};

/*
 * From the "uninitialized" state, attempt to bring the job to "planning" by
 * reading all existing task group records for this job.
 */
mwJobState.prototype.jobRestore = function ()
{
	var job = this;
	var jobid = this.js_jobid;
	var log = this.js_log;
	var phase, curphase = 0;

	mod_assert.ok(this.js_pending_start === undefined);
	this.js_pending_start = new Date();
	this.js_log.info('searching for task groups');

	this.js_moray.listTaskGroups(jobid, function (err, groups) {
		job.js_pending_start = undefined;

		if (err) {
			log.error(err, 'failed to list task groups');
			return;
		}

		/*
		 * Load all task group records into their respective phases
		 * first so that we can process the groups in phase order.
		 */
		groups.forEach(function (group) {
			var tgid = group['taskGroupId'];

			if (group['phaseNum'] >= job.js_phases.length) {
				log.warn('ignoring task group %s: ' +
				    'phase %s is out of range', tgid,
				    group['phaseNum']);
				return;
			}

			phase = job.js_phases[group['phaseNum']];

			if (phase.p_groups.hasOwnProperty(tgid)) {
				log.warn('ignoring duplicate task group %s',
				    tgid);
				return;
			}

			phase.p_groups[tgid] = group;

			if (group['phaseNum'] > curphase)
				curphase = group['phaseNum'];
		});

		/*
		 * If we find task group records for phase i > 0, we know we
		 * completed all phases up through i - 1.  We won't bother
		 * populating the in-memory structures for those phases.
		 */
		log.info('processing job at phase %s', curphase);
		job.js_phasei = curphase;

		mod_assert.equal(job.js_state, 'uninitialized');
		job.js_state = 'planning';
		job.js_state_time = new Date();
		job.tick();
	});
};

/*
 * From the "planning" state, attempt to bring the job to the "running" state by
 * making sure that all input keys for the current phase have been assigned to
 * task groups.
 */
mwJobState.prototype.taskGroupAssign = function ()
{
	var job = this;
	var jobid = this.js_jobid;
	var log = this.js_log;
	var curphase = this.js_phasei;
	var phase = this.js_phases[this.js_phasei];
	var prevphase, phasegroup, tgid, unassigned;

	/*
	 * If we haven't already done so, compute the full set of input keys for
	 * the current phase based on the results of the previous phase's task
	 * groups.  The input keys for the first phase are taken directly from
	 * the job definition.
	 */
	if (phase.p_input.length === 0) {
		log.info('computing input keys for phase %d', curphase);

		if (curphase === 0) {
			phase.p_input = this.js_job['inputKeys'].slice();
		} else {
			prevphase = this.js_phases[curphase - 1];
			prevphase.p_groups.forEach(function (group) {
				group['results'].forEach(function (result) {
					if (result['result'] != 'ok')
						return;

					phase.p_input = phase.p_input.concat(
					    result['outputs']);
				});
			});
		}
	}

	/*
	 * Each time we enter this function, we recompute the set of unassigned
	 * keys.  That's because we may have written out new task group records
	 * since the last time we did this.
	 */
	phase.p_input.forEach(function (key) {
		phase.p_keys_unassigned[key] = true;
	});

	for (tgid in phase.p_groups) {
		phasegroup = phase.p_groups[tgid];
		phasegroup['inputKeys'].forEach(function (key) {
			delete (phase.p_keys_unassigned[key]);
		});
	}

	/*
	 * For unassigned keys, locate them within Manta and partition them into
	 * new task groups.
	 */
	unassigned = Object.keys(phase.p_keys_unassigned);
	log.trace('phase %d: %d unassigned keys (%d total)', curphase,
	    unassigned.length, phase.p_input.length);

	mod_assert.ok(this.js_pending_start === undefined);
	this.js_pending_start = new Date();
	job.js_moray.mantaLocate(unassigned, function (err, locs) {

		if (err) {
			job.js_pending_start = undefined;
			log.warn(err, 'failed to locate Manta keys');
			return;
		}

		var groups = {};
		var key;

		for (key in locs) {
			if (!phase.p_keys_unassigned.hasOwnProperty(key)) {
				log.warn('locate returned extra key: %s', key);
				continue;
			}

			if (locs[key].length < 1) {
				/* XXX append key result to job */
				continue;
			}

			if (!groups.hasOwnProperty(locs[key][0])) {
				groups[locs[key][0]] = {
				    'jobId': jobid,
				    'taskGroupId': mod_uuid.v4(),
				    'host': locs[key][0],
				    'inputKeys': [],
				    'phase': job.js_job['phases'][curphase],
				    'state': 'dispatched',
				    'results': []
				};
			}

			groups[locs[key][0]]['inputKeys'].push(key);
			delete (phase.p_keys_unassigned[key]);
		}

		job.js_moray.saveTaskGroups(groups, function (suberr) {
			job.js_pending_start = undefined;

			if (suberr) {
				log.warn(suberr,
				    'failed to save new task groups');
				return;
			}

			mod_jsprim.forEachKey(groups, function (ntgid, group) {
				mod_assert.ok(!phase.p_groups.hasOwnProperty(
				    ntgid));
				phase.p_groups[ntgid] = group;
			});

			mod_assert.equal(job.js_state, 'planning');

			/*
			 * There may still be unassigned keys, in which case
			 * we'll have to take another lap through the "planning"
			 * state.
			 */
			if (mod_jsprim.isEmpty(phase.p_keys_unassigned)) {
				job.js_state = 'running';
				job.js_state_time = new Date();
			}

			job.tick();
		});
	});
};


/*
 * Kang (introspection) entry points
 */
function mwKangListTypes()
{
	return ([ 'worker', 'jobs' ]);
}

function mwKangListObjects(type)
{
	if (type == 'worker')
		return ([ 0 ]);

	return (Object.keys(mwWorkerInstance.mw_jobs));
}

function mwKangGetObject(type, ident)
{
	if (type == 'worker')
		return ({
		    'uuid': mwWorkerInstance.mw_uuid,
		    'interval': mwWorkerInstance.mw_interval,
		    'moray': mwWorkerInstance.mw_moray.mwm_buckets,
		    'timeout': mwWorkerInstance.mw_timeout ? 'yes' : 'no',
		    'worker_start': mwWorkerInstance.mw_worker_start,
		    'tick_start': mwWorkerInstance.mw_tick_start,
		    'tick_done': mwWorkerInstance.mw_tick_done
		});

	var obj = mwWorkerInstance.mw_jobs[ident];

	return ({
	    'job': obj.js_job,
	    'state': obj.js_state,
	    'state_time': obj.js_state_time,
	    'pending_start': obj.js_pending_start,
	    'phasei': obj.js_phasei,
	    'phases': obj.js_phases
	});
}

var mwWorkerInstance;

/*
 * Currently, running this file directly just exercises some of the
 * functionality defined here.
 */
function main()
{
	var log, moray, worker, jobid;

	log = new mod_bunyan({ 'name': 'worker-demo' });

	moray = new mod_moray.MockMoray({
	    'log': log,
	    'findInterval': mwConf['findInterval'],
	    'jobsBucket': mwConf['jobsBucket'],
	    'taskGroupsBucket': mwConf['taskGroupsBucket']
	});

	worker = mwWorkerInstance = new mwWorker({
	    'uuid': 'worker-001',
	    'moray': moray,
	    'log': log
	});

	jobid = 'job-001';

	moray.put(mwConf['jobsBucket'], jobid, {
	    'jobId': jobid,
	    'phases': [ { } ],
	    'inputKeys': [ 'key1', 'key2', 'key3', 'key4', 'key5', 'key6' ],
	    'results': []
	});

	process.nextTick(function () { worker.start(); });

	mod_kang.knStartServer({
	    'uri_base': '/kang',
	    'port': 8083,
	    'service_name': 'worker demo',
	    'version': '0.0.1',
	    'ident': mod_os.hostname(),
	    'list_types': mwKangListTypes,
	    'list_objects': mwKangListObjects,
	    'get': mwKangGetObject
	}, function (err, server) {
		if (err)
			throw (err);

		var addr = server.address();
		log.info('kang server listening at http://%s:%d',
		    addr['address'], addr['port']);
	});
}

main();