function evidenceListQuery(predicates) {
  return `with selected_evidence as materialized (
            select ve.* from public.violation_evidence ve where ${predicates.join(' and ')}
          ), warning_adjustments as (
            select peer.session_id,
                   sum(case when peer.warning_applied then peer.warning_adjustment else 0 end) adjustment
              from public.violation_evidence peer
             where peer.session_id in (select session_id from selected_evidence)
             group by peer.session_id
          )
          select ve.*,
                 greatest(0, coalesce(sess.warnings, 0) - coalesce(adjustments.adjustment, 0)) as raw_warnings,
                 greatest(0, coalesce(sess.warnings, 0)) as adjusted_warnings
            from selected_evidence ve
            left join public.sessions sess on sess.id = ve.session_id
            left join warning_adjustments adjustments on adjustments.session_id = ve.session_id
           order by ve.created_at desc, ve.id desc`;
}

module.exports = { evidenceListQuery };
