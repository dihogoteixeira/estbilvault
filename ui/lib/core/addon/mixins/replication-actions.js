import { inject as service } from '@ember/service';
import { or } from '@ember/object/computed';
import { isPresent } from '@ember/utils';
import Mixin from '@ember/object/mixin';
import { task } from 'ember-concurrency';

export default Mixin.create({
  store: service(),
  router: service(),
  loading: or('save.isRunning', 'submitSuccess.isRunning'),
  onEnable() {},
  onDisable() {},
  onPromote() {},
  submitHandler: task(function* (action, clusterMode, data, event) {
    let replicationMode = (data && data.replicationMode) || this.replicationMode;
    if (event && event.preventDefault) {
      event.preventDefault();
    }
    this.setProperties({
      errors: [],
    });
    if (data) {
      data = Object.keys(data).reduce((newData, key) => {
        var val = data[key];
        if (isPresent(val)) {
          if (key === 'dr_operation_token_primary' || key === 'dr_operation_token_promote') {
            newData['dr_operation_token'] = val;
          } else {
            newData[key] = val;
          }
        }
        return newData;
      }, {});
      delete data.replicationMode;
    }
    return yield this.save.perform(action, replicationMode, clusterMode, data);
  }),

  save: task(function* (action, replicationMode, clusterMode, data) {
    let resp;
    try {
      resp = yield this.store
        .adapterFor('cluster')
        .replicationAction(action, replicationMode, clusterMode, data);
    } catch (e) {
      return this.submitError(e);
    }
    return yield this.submitSuccess.perform(resp, action, clusterMode);
  }).drop(),

  submitSuccess: task(function* (resp, action, mode) {
    const cluster = this.cluster;
    const replicationMode = this.selectedReplicationMode || this.replicationMode;
    const store = this.store;
    if (!cluster) {
      return;
    }

    if (resp && resp.wrap_info) {
      this.set('token', resp.wrap_info.token);
    }
    if (action === 'secondary-token') {
      this.setProperties({
        loading: false,
        primary_api_addr: null,
        primary_cluster_addr: null,
      });
      return cluster;
    }
    if (this.reset) {
      this.reset();
    }
    if (action === 'enable') {
      // do something to show model is pending
      cluster.set(
        replicationMode,
        store.createRecord('replication-attributes', {
          mode: 'bootstrapping',
        })
      );
      if (mode === 'secondary' && replicationMode === 'performance') {
        // if we're enabing a secondary, there could be mount filtering,
        // so we should unload all of the backends
        store.unloadAll('secret-engine');
      }
    }
    try {
      yield cluster.reload();
    } catch (e) {
      // no error handling here
    }
    cluster.rollbackAttributes();
    if (action === 'disable') {
      yield this.onDisable();
    }
    if (action === 'promote') {
      yield this.onPromote();
    }
    if (action === 'enable') {
      /// onEnable is a method available only to route vault.cluster.replication.index
      // if action 'enable' is called from vault.cluster.replication.mode.index this method is not called
      yield this.onEnable(replicationMode, mode);
    }
  }).drop(),

  submitError(e) {
    if (e.errors) {
      this.set('errors', e.errors);
    } else {
      throw e;
    }
  },
});
