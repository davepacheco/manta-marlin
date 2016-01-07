<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# manta-marlin

This repository is part of the Joyent Manta project.  For contribution
guidelines, issues, and general documentation, visit the main
[Manta](http://github.com/joyent/manta) project page.

Marlin is the Manta compute engine.  It comprises a service, an agent, and a set
of client tools for executing arbitrary user jobs on objects stored in Manta.


# Overview

For overview on the purpose, design, and usage of Marlin, see
docs/index.restdown (or https://mo.joyent.com/docs/marlin).

This document describes the development workflow.


# Quick start for using the tools

Since it's useful to run the Marlin client tools (mrjob, mrjobreport, mrerrors,
etc.) on an OS X laptop, the build system includes hacks to allow just those
bits to build on OS X.  To use these tools:

    $ git clone git@github.com:joyent/manta-marlin.git
    ...
    $ cd manta-marlin
    $ make deps

or just:

    $ npm install git+ssh://git@github.com:joyent/manta-marlin.git

At this point, you'll have several tools available inside the "sbin" directory:

* mrerrors: fetch and summarize errors for a particular job or a given time
  period
* mrjob: create, show, summarize, and manipulate Marlin jobs by interacting with
  Moray directly (instead of the web tier)
* mrjobreport: summarize performance of a job's execution

By default, these tools assume they can contact the 1.moray shard at
localhost:2020.  For a production deployment, it's recommended to set up an ssh
tunnel so that this works.  "mrjob" also supports a MORAY\_URL environment
variable.


# Development

The standard Marlin development environment is a SmartOS zone deployed on a
system with a single-system Manta deployed on it.  This is usually COAL or an
Emeryville lab machine.  In principle, you can develop Marlin on a different
system from the one where you deploy it, but the existing tools are streamlined
for the single-system case.

If you are using COAL for Marlin development, you may need to increase the
ram and disk sizes for the COAL VM.  For example, for 4GB RAM and 70GB disk,
edit your usb-headnode/build.spec.local:

    {
      "build-tgz": "false",
      "answer-file": "answers.json",
      "coal-memsize": 8192,
      "coal-zpool-disk-size": "70"
    }

## Dev zone: Quick setup

The usual procedure is:

1. [Install SDC](https://github.com/joyent/sdc).
2. [Deploy Manta](https://github.com/joyent/manta).
3. Set up your dev zone.  From the global zone, run:

    /opt/smartdc/agents/lib/node_modules/cabase/tools/devsetup -t manta dap

Replace "dap" with whatever username you want to use.  If
http://us-east.manta.joyent.com/$user/public/.ssh/id_rsa.pub exists, this script
will download that to `$HOME/.ssh/authorized_keys` in the new zone.

## Dev zone: gritty details

**Skip this section if you did the quick setup above.**

The above script takes care of setting up /etc/resolv.conf in your development
zone to refer to the Manta name servers and adds several environment variables
to the new user's profile script:

    $ export MAHI_URL=http://authcache.sf-1.joyent.us/
    $ export MORAY_URL=tcp://1.moray.sf-1.joyent.us:2020/
    $ export MANTA_URL=https://manta.sf-1.joyent.us
    $ export MANTA_USER=poseidon
    $ export MANTA_KEY_ID=ff:4a:ad:ac:92:86:ec:d2:5a:9d:88:c8:e8:12:8d:15
    $ export MANTA_TLS_INSECURE=1

These are all specific to the install.  Don't just copy the values here.  To get
the MANTA\_KEY\_ID for poseidon, use:

    # sdc-ldap search -b "$(sdc-ldap search login=poseidon | \
          head -1 | cut -c5-)" objectclass=sdckey | \
          awk '/^fingerprint:/{ print $2 }'
    ff:4a:ad:ac:92:86:ec:d2:5a:9d:88:c8:e8:12:8d:15

To run the test suite, you must also copy the ssh key of the "poseidon" user to
to your dev zone.  By default, the tests expect it in
"$HOME/.ssh/id\_rsa{,.pub}".  However, you can also set the MANTA\_KEY
environment variable if it located somewhere else.  You can get the poseidon key
from the "ops" Manta zone.  If your dev zone is on the same box as the ops zone,
you can do this with:

    # cp /zones/$(vmadm lookup alias=~ops)/root/root/.ssh/id_rsa* \
         /zones/$YOUR_DEV_ZONE_UUID/root/$YOUR_LOGIN_NAME/.ssh

Also, if you find the tests are failing in COAL due to retries in Marlin you
can set the MARLIN\_TESTS\_STRICT environment variable to false, like so:

    $ export MARLIN_TESTS_STRICT=false

Finally, devsetup also adds privileges to your user.  You can do this manually
by running this as root in your zone:

    $ usermod -K defaultpriv=basic,dtrace_user,dtrace_proc,contract_event,sys_mount,hyprlofs_control 'user'

Again, "devsetup" takes care of all this.  This is all only necessary if you're
in a non-standard configuration.


## Clone and build

This part's easy:

    $ git clone git@github.com:joyent/manta-marlin.git
    $ cd manta-marlin
    $ . dev/env.sh
    $ make
    ...
    $ make check
    ...
    check ok

Whenever you start working on Marlin, use `. dev/env.sh` to load PATH and other
environment variables to include both the Marlin tools (mrjob and the like) and
the Manta tools (mls, mput, etc.)

## Running the code

There are two main components in Marlin: the jobsupervisor and the agent.

The jobsupervisor can be run directly out of the repo.  The easiest way to get
started is to copy the config.json file from an existing Marlin jobsupervisor
deployed on the same system, modify the port number (since the default is a
privileged port), **disable the worker whose configuration you copied**, and
then run:

    $ cd manta-marlin
    $ . dev/env.sh
    $ make
    $ node build/proto/root/opt/smartdc/marlin/lib/worker/server.js \
          ../config.json | tee ../worker.out | bunyan -o short

With this approach, you can apply changes by stopping the jobsupervisor, running
"make proto", and starting the jobsupervisor again.

The agent must be run inside the global zone, since it uses other zones to
actually execute tasks.  To run your own agent, you'll want to run `tools/mru`
from inside the global zone, as in
`/zones/$your_dev_zone/root/home/$your_user/marlin/tools/mru`.  This script will
reconfigure the marlin-agent SMF service running in the global zone to execute
the code in the proto area of your workspace
(`/zones/$your_dev_zone/root/home/$your_user/marlin/build/proto/root`).  This
way, you can make changes in your workspace, run "make proto", and simply
`svcadm restart marlin-agent` to test them out.  Again, this process assumes a
single-system Manta deployment.  To test on a multi-system deployment, you'll
want to go through the complete build and upgrade process, which is basically
"make" in the repo, copy the agent tarball to the target system, and "apm
install" that tarball.

## Development tools

The main development tool is "mrjob", which allows you to create, update, and
fetch detailed status about Marlin jobs by talking to Moray directly.

To create a job, you must first create an auth token against Manta.  The
easiest way to do this is to sign the 'POST /$user/tokens' URL:

    $ msign -m POST /dap/tokens
    https://manta.joyent.us/dap/tokens?...

Then use the URL you were given with curl to create a new token:

    $ curl -k -XPOST 'https://manta.joyent.us/dap/tokens?...'
    {"token":"..."}

Copy this token, and pass that to "mrjob submit" using the "-t" option.  You'll
also need to set MAHI\_URL appropriately.

    $ jobid=$(mrjob submit -t '...' -m wc); echo $jobid
    8abafb0d-9e9c-4023-b82b-73c4b52559f2

For details on using "mrjob" to submit more complex jobs, add keys to jobs,
fetch detailed jobs, and so on, run "mrjob --help".


## Test suite

The Marlin test suite is not comprehensive, but it exercises a good portion of
the stack.  **The test suite should always be totally clean.  Tickets should be
filed on any failures not due to local changes or misconfiguration.**

### Running the test suite in a zone

The main way of running the test suite is inside your development zone, usually
on the same physical system where you're testing a one-system Manta
installation.  **This approach skips some tests that require verifying private
state -- see "Running the full test suite" below for details.**

This environment assumes you set up the environment variables and ssh keys as
described above.  To run the test suite, just run:

    $ dev/tools/catest -a

You can run individual tests manually with just:

    $ node proto/root/opt/smartdc/marlin/test/...

Many of them emit bunyan output, so you may want to pipe that to bunyan(1).

### Running the full test suite

Running the test suite in a zone can only test the user-facing aspects of
Marlin: behavior of the APIs, job inputs, job outputs, job errors, results, and
so on.  It's also important to test some implementation details, like that
metering worked correctly.  To do this, the Marlin test suite must be run from
the global zone so it can access the agent directly.  In this environment,
catest will automatically configure itself based on the agent's configuration
(i.e., you don't have to worry about the above environment variables), and it
will automatically run the extra checks.

Note that this full test suite only works on single-system Manta installations,
since it assumes all tasks will be executed by the local agent.

To run individual tests, you have to set up the environment with:

    # cd /zones/$your_zone/root/home/$your_user/marlin
    # . dev/env.sh
    # . dev/tools/catest_init.sh
    # catest_init_global

Then you can run individual tests just like inside a zone:

    $ node test/...

### Stress testing

In one shell, start the worker in a way that will be automatically restarted:

    $ while :; do LOG_LEVEL=debug node \
        build/proto/root/opt/smartdc/marlin/lib/worker/server.js \
        ../config.json | tee -a ../worker.out | bunyan -linfo; done

In another, start a loop that will *kill* the supervisor a random interval
between 5 and 30 seconds apart.  There's a script in tools/ for this:

    $ dev/tools/test_sup_kill.sh

And finally, run the test suite in "stress" mode, which is a little laxer about
transient failures:

    $ for (( i = 0; ; i++ )) { \
        echo "$i: $(date)"; \
        if ! node build/proto/root/opt/smartdc/marlin/test/live/tst.main.js \
            -S >> ../tests.out 2>&1; then
            echo "FAILED at $(date)";
            break;
        fi
      }

You can also test periodic agent crashes using a script to periodically kill the
agent.  The minimum timeout for this script is longer than the corresponding
supervisor script because jobs fail if the agent fails too many times while
they're running.  You must run this from the global zone:

    # /zones/$YOUR_ZONE/root/home/$YOUR_USER/marlin/dev/tools/test_agent_kill.sh


### Zone scheduler testing

The Marlin agent contains a zone scheduler that is responsible for assigning
compute zones to job tasks.  The scheduler is described in detail in
[agent/lib/agent/agent.js](agent/lib/agent/agent.js).  The scheduler does not
have an automated test suite, but it does have tools to generate basic
workloads and visualize zone assignments so that you can see what it's done and
evaluate the behavior.  The tools are:

* [mrschedtest](dev/test/live/mrschedtest): This tool uses the Manta API to
  launch any of several canned workloads.  These workloads are intended to
  represent basic scheduler use-cases: single jobs bursting to use all zones,
  multiple jobs sharing zones fairly, and so on.  You can run multiple workloads
  sequentially.  mrschedtest uses the agent's monitoring interface (the kang
  interface) to make sure that the system is quiesced.
* [mrjobconcurrency](agent/sbin/mrjobconcurrency): This tool examines an agent
  log file and a file containing a list of jobids to generate a GNUplot file
  that shows the number of zones assigned to each job over time.
* [mkgraphs](dev/tools/mkgraphs): This is just a convenience script to run
  mrjobconcurrency for a bunch of workloads at once.

The typical way to evaluate the scheduler behavior is to:

1. Run all the workloads using `mrschedtest`.  This generates per-workload
   output directories that will be used later, although all the important data
   is stored in the agent log file.
2. Concatenate the agent log files for the entire testing period into one file,
   in chronological order.
3. Run `mkgraphs` on the output directories.  This will run "mrjobconcurrency"
   on each one, using the agent log file as input, and produce GNUplot files.
4. Run the GNUplot files through gnuplot(1) to visualize zone concurrency.

Let's show these in detail.  First, run the workloads:

    $ mkdir schedtest
    $ cd schedtest
    $ nohup ../build/node/bin/node --abort-on-uncaught-exception $PROTO/test/live/mrschedtest KANG_HOST_PORT WORKLOAD_NAMES... > schedtest_all.out &

You'll need to fill in:

* `KANG_HOST_PORT`: this is the IP address and port number where the Marlin
  agent's kang server is listening.  This is almost always port 9080.  An
  example value might be "172.27.10.4:9080" (but this depends entirely on your
  deployment).
* `WORKLOAD_NAMES...`: these are the workload names supported by "mrschedtest".
  You can specify any number of these, and they'll be run sequentially.

At present, this process takes about two hours.

Once you've run the workloads, you'll need to concatenate the agent logs for the
testing period into one file.  Usually you'll need one or two log files that
were already uploaded to Manta (under
/poseidon/stor/logs/marlin-agent/YYYY/MM/DD/HH/SERVER\_HOSTNAME.log), plus
potentially the current agent log file.  Fetch each one you need, then
concatenate them in order into a file called "headnode.log".

Once you've got the workload output directories plus the agent log file, then
you can run "mkgraphs" on all of those output directories:

    $ ../dev/tools/mkgraphs mrschedtest-*

This will take a minute or two and produce GNUplot files in each of those
output directories.  You can run these through gnuplot to visualize zone
concurrency.


# Before pushing changes

- Your code should be "make prepush" clean.  That includes both "make check" and
  "make test" (the test suite).
- Assess the test impact of your changes -- make sure you've run all manual
  tests you can think of, and automated all of the ones that can reasonably be
  automated.
- Assess any impact on fresh install / deployment and make sure you've tested
  that if necessary.
- Assess any impact on upgrade, including flag days for developers or existing
  deployments (e.g., us-beta).
- Code review is strongly suggested.
